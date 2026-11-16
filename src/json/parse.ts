/**
 * JSON text → value, recording where each value is, for the decoders'
 * `positions` option.
 *
 * Strict RFC 8259 JSON giving exactly the values `JSON.parse` gives: a
 * repeated member keeps its first place and its last value, `__proto__` is an
 * ordinary member, and numbers are read by `Number()`. Escapes may produce
 * lone surrogates, as with `JSON.parse`. It runs with an explicit stack, so
 * deep nesting can't overflow the call stack.
 */

/** Where an object or array is, and where its members or items are: offsets in UTF-16 code units. */
export interface JsonPlace {
  /** The offset of the `{` or `[`. */
  readonly offset: number;
  /** For an object: member name → the offset of its name's opening quote (the last, if repeated). */
  readonly members?: Map<string, number>;
  /** For an array: the offset of each item. */
  readonly items?: number[];
}

/** Malformed JSON, with where the problem is. */
export class JsonSyntaxProblem extends Error {
  override name = 'JsonSyntaxProblem';

  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

export interface PlacedJson {
  readonly value: unknown;
  /** The place of every object and array in the value. */
  readonly places: WeakMap<object, JsonPlace>;
}

type Frame = { readonly obj: Record<string, unknown>; readonly members: Map<string, number>; readonly offset: number; key: string; keyOffset: number } | { readonly arr: unknown[]; readonly items: number[]; readonly offset: number };

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Parses JSON text.
 *
 * @throws JsonSyntaxProblem
 */
export function parseJsonText(text: string): PlacedJson {
  const places = new WeakMap<object, JsonPlace>();
  const stack: Frame[] = [];
  const n = text.length;
  let i = 0;

  const fail = (message: string, at = i): never => {
    throw new JsonSyntaxProblem(message, at);
  };
  const unexpected = (what: string): never => (i >= n ? fail(`unexpected end of the text; expected ${what}`) : fail(`unexpected ${JSON.stringify(text[i])}; expected ${what}`));
  const ws = (): void => {
    for (; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
    }
  };
  const string = (): string => {
    if (text.charCodeAt(i) !== 0x22) unexpected('a string');
    const start = i++;
    let out = '';
    let run = i;
    for (;;) {
      if (i >= n) fail('unterminated string', start);
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(run, i++);
        return out;
      }
      if (c < 0x20) fail('control character in a string');
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(run, i);
      const e = text[i + 1];
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const r = e === undefined ? undefined : ESCAPES[e];
        if (r === undefined) fail('invalid escape');
        out += r;
        i += 2;
      }
      run = i;
    }
  };
  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) unexpected('a value');
    i += word.length;
    return value;
  };
  /** After a member name: the colon. */
  const colon = (): void => {
    ws();
    if (text.charCodeAt(i) !== 0x3a) unexpected("':'");
    i++;
  };

  for (;;) {
    ws();
    let value: unknown;
    let start = i;
    const c = text.charCodeAt(i);
    if (c === 0x7b) {
      i++;
      const obj: Record<string, unknown> = {};
      const members = new Map<string, number>();
      places.set(obj, { offset: start, members });
      ws();
      if (text.charCodeAt(i) === 0x7d) {
        i++;
        value = obj;
      } else {
        const keyOffset = i;
        const key = string();
        colon();
        stack.push({ obj, members, offset: start, key, keyOffset });
        continue;
      }
    } else if (c === 0x5b) {
      i++;
      const arr: unknown[] = [];
      const items: number[] = [];
      places.set(arr, { offset: start, items });
      ws();
      if (text.charCodeAt(i) === 0x5d) {
        i++;
        value = arr;
      } else {
        stack.push({ arr, items, offset: start });
        continue;
      }
    } else if (c === 0x22) value = string();
    else if (c === 0x74) value = literal('true', true);
    else if (c === 0x66) value = literal('false', false);
    else if (c === 0x6e) value = literal('null', null);
    else {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m === null) unexpected('a value');
      i += m![0].length;
      value = Number(m![0]);
    }

    // A value is complete: put it in its container, and close containers that end here.
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        ws();
        if (i < n) fail(`unexpected ${JSON.stringify(text[i])} after the JSON value`);
        return { value, places };
      }
      if ('obj' in top) {
        if (top.key === '__proto__') Object.defineProperty(top.obj, top.key, { value, writable: true, enumerable: true, configurable: true });
        else top.obj[top.key] = value;
        top.members.set(top.key, top.keyOffset);
        ws();
        const d = text.charCodeAt(i);
        if (d === 0x2c) {
          i++;
          ws();
          top.keyOffset = i;
          top.key = string();
          colon();
          break;
        }
        if (d !== 0x7d) unexpected("',' or '}'");
        i++;
        stack.pop();
        value = top.obj;
      } else {
        top.arr.push(value);
        top.items.push(start);
        ws();
        const d = text.charCodeAt(i);
        if (d === 0x2c) {
          i++;
          break;
        }
        if (d !== 0x5d) unexpected("',' or ']'");
        i++;
        stack.pop();
        value = top.arr;
      }
      start = top.offset;
    }
  }
}
