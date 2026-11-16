/**
 * Linear-time matching of parsed XSD patterns.
 *
 * A backtracking engine (JavaScript's RegExp among them) can take time
 * exponential in the value's length on patterns such as `([^%]+|%[sc])+`, and
 * patterns come from modules while values come from devices and users. XSD
 * patterns have no backreferences or lookaround, so they are regular and can
 * be matched by an automaton instead:
 *
 * - The pattern compiles to a small program (CHAR, SPLIT, JMP, MATCH) in the
 *   style of Thompson's construction. Counted repeats are expanded, and the
 *   program may have at most {@link MAX_PATTERN_SIZE} instructions.
 * - The program runs as a lazy DFA: a state is the set of program positions
 *   live after the characters so far, built the first time it is reached and
 *   cached. A pattern caches at most {@link MAX_DFA_STATES} states; past that
 *   the match carries on uncached (NFA simulation), still linear.
 *
 * Character classes are tested one code point at a time with a one-character
 * `v`-flag RegExp of the class's translation, which cannot backtrack and keeps
 * one definition of what each class contains.
 */

import { XsdRegexError } from './xsd-regex-error.js';
import type { XsdRegexNode } from './xsd-regex.js';

/** The most instructions a pattern's program may have. Counted repeats are expanded, so `[a-z]{1,1000}` costs about 2,000. */
export const MAX_PATTERN_SIZE = 100_000;
/** The most DFA states one pattern caches. Matching past it is uncached but still linear. */
export const MAX_DFA_STATES = 2_000;

/** Code points above ASCII whose class membership each class remembers. */
const MEMO_LIMIT = 4_096;
/** Distinct classes shared between patterns. Beyond it, new classes are private to their pattern. */
const SHARED_CLASS_LIMIT = 2_000;

const CHAR = 0;
const SPLIT = 1;
const JMP = 2;
const MATCH = 3;

/** Membership of one character class, with ASCII and other code points remembered. */
class CharClass {
  readonly #regexp: RegExp;
  /** -1 unknown, 0 no, 1 yes. */
  readonly #ascii = new Int8Array(128).fill(-1);
  readonly #memo = new Map<number, boolean>();

  constructor(source: string) {
    this.#regexp = new RegExp(`^${source}$`, 'v');
  }

  has(cp: number): boolean {
    if (cp < 128) {
      const known = this.#ascii[cp]!;
      if (known >= 0) return known === 1;
      const yes = this.#regexp.test(String.fromCharCode(cp));
      this.#ascii[cp] = yes ? 1 : 0;
      return yes;
    }
    const known = this.#memo.get(cp);
    if (known !== undefined) return known;
    const yes = this.#regexp.test(String.fromCodePoint(cp));
    if (this.#memo.size < MEMO_LIMIT) this.#memo.set(cp, yes);
    return yes;
  }
}

const sharedClasses = new Map<string, CharClass>();

function charClass(source: string): CharClass {
  let c = sharedClasses.get(source);
  if (c === undefined) {
    c = new CharClass(source);
    if (sharedClasses.size < SHARED_CLASS_LIMIT) sharedClasses.set(source, c);
  }
  return c;
}

/** Instructions in the program for a node: an upper bound, computed before anything is built. */
function sizeOf(n: XsdRegexNode): number {
  switch (n.kind) {
    case 'char':
    case 'set':
      return 1;
    case 'seq':
      return n.items.reduce((sum, i) => sum + sizeOf(i), 0);
    case 'alt':
      return n.branches.reduce((sum, b) => sum + sizeOf(b), 0) + 2 * (n.branches.length - 1);
    case 'group':
      return sizeOf(n.inner);
    case 'repeat': {
      // At least 1 per copy, so the limit also bounds the copies of an empty atom, as in `(){99999999}`.
      const s = Math.max(sizeOf(n.atom), 1);
      return s * n.min + (n.max === undefined ? s + 2 : (n.max - n.min) * (s + 1));
    }
  }
}

interface DfaState {
  /** Sorted CHAR and MATCH positions. */
  readonly pcs: Int32Array;
  readonly match: boolean;
  /** Next state per ASCII code point, -1 when not yet known. Made on first use. */
  ascii: Int32Array | undefined;
  /** Next state per other code point, up to MEMO_LIMIT of them. Made on first use. */
  other: Map<number, number> | undefined;
}

/**
 * A compiled XSD pattern. {@link test} takes time linear in the length of the
 * value, whatever the pattern. Made by `compileXsdRegex`.
 */
export class XsdRegex {
  /** The pattern as written, an XSD regular expression. */
  readonly source: string;

  /** Three entries per instruction: the op, then CHAR's class index or SPLIT and JMP's first target, then SPLIT's second target. */
  readonly #prog: Int32Array;
  readonly #classes: CharClass[] = [];

  // Made on the first test, since most patterns in a large schema never see a value.
  /** Visited marks for closures, stamped with #generation. */
  #mark: Uint32Array | undefined;
  #generation = 0;
  /** DFA states; the start state is the first. */
  #states: DfaState[] | undefined;
  #index: Map<string, number> | undefined;

  /** @internal Use `compileXsdRegex`. */
  constructor(source: string, root: XsdRegexNode) {
    this.source = source;
    const size = sizeOf(root) + 1;
    if (!(size <= MAX_PATTERN_SIZE)) {
      throw new XsdRegexError(
        `pattern ${JSON.stringify(source)} is too large to match safely: its automaton would have more than ${MAX_PATTERN_SIZE} instructions, usually from large counted repeats`,
      );
    }
    const prog = (this.#prog = new Int32Array(size * 3));
    const classIndex = new Map<string, number>();
    let pc = 0;
    const put = (op: number, x = 0, y = 0): number => {
      prog[pc * 3] = op;
      prog[pc * 3 + 1] = x;
      prog[pc * 3 + 2] = y;
      return pc++;
    };
    const emit = (n: XsdRegexNode): void => {
      switch (n.kind) {
        case 'char':
        case 'set': {
          const source = n.kind === 'set' ? n.source : `[\\u{${n.cp.toString(16)}}]`;
          let i = classIndex.get(source);
          if (i === undefined) {
            i = this.#classes.push(charClass(source)) - 1;
            classIndex.set(source, i);
          }
          put(CHAR, i);
          return;
        }
        case 'seq':
          for (const item of n.items) emit(item);
          return;
        case 'group':
          emit(n.inner);
          return;
        case 'alt': {
          // SPLIT to this branch or the next; each branch but the last JMPs to the end.
          const jumps: number[] = [];
          n.branches.forEach((b, i) => {
            if (i === n.branches.length - 1) {
              emit(b);
              return;
            }
            const split = put(SPLIT, pc + 1);
            emit(b);
            jumps.push(put(JMP));
            prog[split * 3 + 2] = pc;
          });
          for (const j of jumps) prog[j * 3 + 1] = pc;
          return;
        }
        case 'repeat': {
          for (let i = 0; i < n.min; i++) emit(n.atom);
          if (n.max === undefined) {
            // L: SPLIT body, out; body; JMP L
            const split = put(SPLIT, pc + 1);
            emit(n.atom);
            put(JMP, split);
            prog[split * 3 + 2] = pc;
          } else {
            // Optional copies, each able to skip to the end.
            const splits: number[] = [];
            for (let i = n.min; i < n.max; i++) {
              splits.push(put(SPLIT, pc + 1));
              emit(n.atom);
            }
            for (const s of splits) prog[s * 3 + 2] = pc;
          }
          return;
        }
      }
    };
    emit(root);
    put(MATCH);
  }

  /** True when the whole of `text` matches the pattern. */
  test(text: string): boolean {
    const states = (this.#states ??= []);
    if (states.length === 0) this.#state(this.#closure([0]));
    let s = states[0]!;
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++;
      let next = (cp < 128 ? s.ascii?.[cp] : s.other?.get(cp)) ?? -1;
      if (next < 0) {
        const pcs = this.#step(s.pcs, cp);
        next = this.#state(pcs);
        if (next < 0) return this.#simulate(pcs, text, i + 1);
        if (cp < 128) (s.ascii ??= new Int32Array(128).fill(-1))[cp] = next;
        else if ((s.other ??= new Map()).size < MEMO_LIMIT) s.other.set(cp, next);
      }
      s = states[next]!;
      if (s.pcs.length === 0) return false;
    }
    return s.match;
  }

  /** Carries on a match without caching states, once the cache is full. */
  #simulate(pcs: Int32Array, text: string, from: number): boolean {
    for (let i = from; i < text.length; i++) {
      if (pcs.length === 0) return false;
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++;
      pcs = this.#step(pcs, cp);
    }
    return this.#matches(pcs);
  }

  /** The positions live after `cp`, from the positions live before it. */
  #step(pcs: Int32Array, cp: number): Int32Array {
    const prog = this.#prog;
    const next: number[] = [];
    for (const pc of pcs) {
      if (prog[pc * 3] === CHAR && this.#classes[prog[pc * 3 + 1]!]!.has(cp)) next.push(pc + 1);
    }
    return this.#closure(next);
  }

  /** Follows SPLIT and JMP from `from`, keeping the CHAR and MATCH positions, sorted. */
  #closure(from: number[]): Int32Array {
    const prog = this.#prog;
    const mark = (this.#mark ??= new Uint32Array(prog.length / 3));
    if (++this.#generation === 0xffffffff) {
      mark.fill(0);
      this.#generation = 1;
    }
    const g = this.#generation;
    const out: number[] = [];
    const stack = from.slice();
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (mark[pc] === g) continue;
      mark[pc] = g;
      switch (prog[pc * 3]) {
        case SPLIT:
          stack.push(prog[pc * 3 + 1]!, prog[pc * 3 + 2]!);
          break;
        case JMP:
          stack.push(prog[pc * 3 + 1]!);
          break;
        default:
          out.push(pc);
      }
    }
    return Int32Array.from(out).sort();
  }

  /** MATCH is the last instruction, so it sorts last. */
  #matches(pcs: Int32Array): boolean {
    return pcs.length > 0 && this.#prog[pcs[pcs.length - 1]! * 3] === MATCH;
  }

  /** The cached state for a position set, adding it if there is room; -1 when the cache is full. */
  #state(pcs: Int32Array): number {
    const states = this.#states!;
    const key = pcs.join(',');
    const index = (this.#index ??= new Map<string, number>());
    const known = index.get(key);
    if (known !== undefined) return known;
    if (states.length >= MAX_DFA_STATES) return -1;
    index.set(key, states.length);
    states.push({ pcs, match: this.#matches(pcs), ascii: undefined, other: undefined });
    return states.length - 1;
  }
}

