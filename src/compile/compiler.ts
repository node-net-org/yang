/**
 * Builds the schema tree from loaded modules (RFC 7950 §7).
 *
 * Phases:
 * 1. Module records, features, identities, extensions (context.ts).
 * 2. Data trees of implemented modules: data definitions, operations and
 *    notifications, with groupings expanded in place (uses, refine, uses
 *    augment) and disabled if-features removed.
 * 3. Top-level augments, repeated until no more apply, since one augment
 *    can target a node another adds. Augmenting a module that is only
 *    imported makes it implemented (RFC 7950 §5.6.5).
 * 4. Deviations.
 * 5. List keys, unique, choice defaults, leafref targets, default values,
 *    and the checks on mandatory nodes (default cases, augments of other modules).
 *
 * Nodes from a grouping are bound to the namespace of the module where the
 * outermost `uses` appears (RFC 7950 §7.13), while names inside the grouping
 * (types, groupings, identities, features) resolve in the grouping's own
 * module. Hence two contexts while building: the lexical scope, and the
 * binding module.
 */

import { substatement, substatements, isExtension, type Statement } from '../parse/statement.js';
import type {
  CompiledModule,
  CaseNode,
  DataNode,
  ExtensionInstance,
  InputNode,
  LeafListNode,
  LeafNode,
  Must,
  NotificationNode,
  RpcNode,
  SchemaNode,
  Status,
  WhenCondition,
  YangType,
} from '../schema/model.js';
import { leafrefPredicates, type PathName, type PathPredicate } from '../types/path.js';
import { checkValue } from '../types/value.js';
import { parseText } from '../data/lexical.js';
import type { TypedValue } from '../data/value.js';
import type { Schema } from '../schema/schema.js';
import { docOf, referrer, splitRef, statusOf, type CompileContext, type MutableModule, type Scope } from './context.js';
import { nodeStatus, type StatusParty } from '../schema/status.js';
import type { LoadedFile } from './loader.js';
import { instantiate, TypeResolver } from './types.js';

/**
 * A node while it's being built: every kind's fields, all optional, so
 * phases can fill them in. Cast to the public {@link SchemaNode} types when done.
 */
interface MNode {
  kind: SchemaNode['kind'];
  name: string;
  module: MutableModule;
  parent: MNode | undefined;
  children: MNode[];
  config: boolean;
  status: Status;
  description?: string;
  reference?: string;
  when: WhenCondition[];
  must: Must[];
  extensions: ExtensionInstance[];
  ifFeatures: string[];
  statement: Statement;
  presence?: string;
  keys?: LeafNode[];
  unique?: LeafNode[][];
  minElements?: number;
  maxElements?: number | undefined;
  orderedBy?: 'system' | 'user';
  type?: YangType;
  default?: string;
  defaults?: string[];
  defaultValue?: TypedValue;
  defaultValues?: TypedValue[];
  units?: string;
  mandatory?: boolean;
  isKey?: boolean;
  defaultCase?: CaseNode;
  shorthand?: boolean;
  input?: InputNode;
  output?: InputNode;
}

interface BuildContext {
  readonly scope: Scope;
  /** The module whose namespace new nodes are bound to. */
  readonly module: MutableModule;
  readonly parent: MNode | undefined;
  readonly config: boolean;
  /** Inside an rpc, action or notification, where config doesn't apply. */
  readonly inOperation: boolean;
  /** Groupings being expanded, to catch a grouping that uses itself. */
  readonly groupings: readonly Statement[];
}

const DATA_DEF = new Set(['container', 'leaf', 'leaf-list', 'list', 'choice', 'anydata', 'anyxml']);
const SHORTHAND = new Set(['container', 'leaf', 'leaf-list', 'list', 'anydata', 'anyxml', 'choice']);
/** Nodes that don't appear in data: paths through data skip them. */
const TRANSPARENT = new Set(['choice', 'case', 'input', 'output']);

export class TreeBuilder {
  readonly #types: TypeResolver;
  /** Extra information about nodes that the public model doesn't carry. */
  readonly #explicitConfig = new WeakSet<MNode>();
  readonly #keyNames = new WeakMap<MNode, { names: string[]; at: Statement }>();
  readonly #uniqueArgs = new WeakMap<MNode, Statement[]>();
  readonly #defaultCase = new WeakMap<MNode, Statement>();
  /** The file whose prefixes apply to a node's default value(s). */
  readonly #defaultFile = new WeakMap<MNode, LoadedFile>();
  readonly #built = new Set<string>();
  /** Names of nodes an if-feature removed, by parent node (or module, at the top level). */
  readonly #disabled = new WeakMap<object, Set<string>>();
  readonly #leaves: MNode[] = [];
  /** Nodes a `deviate not-supported` removed. Their subtrees are no longer in the schema. */
  readonly #removed = new WeakSet<MNode>();
  /** Nodes (or modules, at the top level) that an if-feature or deviation removed something from. */
  readonly #incomplete = new WeakSet<object>();
  /** The top nodes of each structure, by each node at the top of one: where an absolute path inside it starts. */
  readonly #structureRoots = new WeakMap<MNode, () => MNode[]>();
  readonly #lists: MNode[] = [];
  readonly #choices: MNode[] = [];

  constructor(private readonly ctx: CompileContext) {
    this.#types = new TypeResolver(ctx);
  }

  get types(): TypeResolver {
    return this.#types;
  }

  /** Called after a module's nodes are built: where extensions such as `sx:structure` build theirs. */
  onModuleBuilt: ((module: MutableModule) => void) | undefined;

  /** Builds the data tree, operations and notifications of a module, once. */
  buildModule(module: MutableModule): void {
    const key = this.ctx.keyOf(module);
    if (this.#built.has(key)) return;
    this.#built.add(key);
    const loaded = this.ctx.loaded.get(key)!;
    for (const file of loaded.files) {
      const bc: BuildContext = { scope: { file }, module, parent: undefined, config: true, inOperation: false, groupings: [] };
      for (const node of this.#body(file.statement.substatements, bc)) {
        if (node.kind === 'rpc') module.rpcs.push(node as unknown as RpcNode);
        else if (node.kind === 'notification') module.notifications.push(node as unknown as NotificationNode);
        else module.dataNodes.push(node as unknown as DataNode);
      }
    }
    this.onModuleBuilt?.(module);
  }

  /**
   * Builds the data definitions of an extension statement such as
   * `sx:structure`, outside the datastore tree: under `parent` when given
   * (the container a structure is encoded as), or as top nodes. Nodes are
   * configuration (RFC 8791 ignores `config`), bound to `module`, and an
   * absolute path inside them starts at the structure's top. Lookups of
   * typedefs and groupings see those defined in the statement.
   */
  buildDetached(statement: Statement, file: LoadedFile, module: MutableModule, parent: MNode | undefined): MNode[] {
    const bc: BuildContext = { scope: { file, statement, parent: { file } }, module, parent, config: true, inOperation: false, groupings: [] };
    const nodes = this.#body(statement.substatements, bc);
    const top = parent === undefined ? nodes : [parent];
    for (const n of top) this.#structureRoots.set(n, () => (parent === undefined ? nodes : parent.children));
    return nodes;
  }

  /** A synthetic container for a structure, named after it (RFC 8791 §3). */
  structureContainer(statement: Statement, file: LoadedFile, module: MutableModule): MNode {
    return this.#base('container', statement, { scope: { file }, module, parent: undefined, config: true, inOperation: false, groupings: [] });
  }

  /** The top nodes an absolute path in this node's tree starts from: a structure's, or undefined for the datastore. */
  structureRoots(node: MNode): MNode[] | undefined {
    let top = node;
    while (top.parent !== undefined) top = top.parent;
    return this.#structureRoots.get(top)?.();
  }

  // ---------------------------------------------------------------------------
  // Building nodes

  /** Builds the nodes defined by a list of substatements: data definitions, uses, operations, notifications. */
  #body(statements: readonly Statement[], bc: BuildContext): MNode[] {
    const out: MNode[] = [];
    for (const s of statements) {
      if (DATA_DEF.has(s.keyword)) {
        const n = this.#node(s, bc);
        if (n !== undefined) out.push(n);
      } else if (s.keyword === 'uses') {
        out.push(...this.#uses(s, bc));
      } else if (s.keyword === 'rpc' || s.keyword === 'action') {
        const n = this.#operation(s, bc);
        if (n !== undefined) out.push(n);
      } else if (s.keyword === 'notification') {
        const n = this.#notification(s, bc);
        if (n !== undefined) out.push(n);
      }
    }
    this.#checkDuplicates(out, bc);
    return out;
  }

  #checkDuplicates(nodes: readonly MNode[], bc: BuildContext): void {
    const seen = new Map<string, MNode>();
    const existing = bc.parent?.children ?? [];
    for (const n of [...existing, ...nodes]) {
      for (const leaf of TRANSPARENT.has(n.kind) && n.kind !== 'input' && n.kind !== 'output' ? [n, ...dataDescendants(n)] : [n]) {
        if (leaf.kind === 'case') continue;
        const key = `${leaf.module.name}:${leaf.name}`;
        const prior = seen.get(key);
        if (prior !== undefined && prior !== leaf) {
          this.ctx.error('duplicate-node', `'${leaf.name}' is defined more than once at the same level`, leaf.statement);
        }
        seen.set(key, leaf);
      }
    }
  }

  #base(kind: SchemaNode['kind'], s: Statement, bc: BuildContext): MNode {
    const file = bc.scope.file;
    const when = substatement(s, 'when');
    const node: MNode = {
      kind,
      name: s.argument ?? '',
      module: bc.module,
      parent: bc.parent,
      children: [] as MNode[],
      config: bc.inOperation ? false : bc.config,
      status: statusOf(s),
      ...docOf(s),
      when: when === undefined ? [] : [this.ctx.when(when, file, 'node')],
      must: this.ctx.mustsOf(s, file),
      extensions: this.ctx.extensionsOf(s, file),
      ifFeatures: ifFeaturesOf(s),
      statement: s,
    };
    const config = substatement(s, 'config');
    if (config !== undefined && !bc.inOperation) {
      const value = config.argument === 'true';
      if (value && !bc.config) this.ctx.error('config-true-under-false', `'${node.name}' can't be config true inside config false data`, config);
      node.config = value;
      this.#explicitConfig.add(node);
    }
    return node;
  }

  #inner(s: Statement, bc: BuildContext, node: MNode, extra: Partial<BuildContext> = {}): BuildContext {
    return { ...bc, scope: { file: bc.scope.file, statement: s, parent: bc.scope }, parent: node, config: node.config, ...extra };
  }

  /** Whether the statement's if-features allow it; if not, remembers its name as removed. */
  #enabled(s: Statement, bc: BuildContext): boolean {
    if (this.ctx.enabled(s, bc.scope.file, bc.scope)) return true;
    this.#incomplete.add(bc.parent ?? bc.module);
    if (s.argument !== undefined) {
      const key: object = bc.parent ?? bc.module;
      let set = this.#disabled.get(key);
      if (set === undefined) this.#disabled.set(key, (set = new Set()));
      set.add(s.argument);
    }
    return false;
  }

  /**
   * Whether an if-feature removed the node `name` from `parent` (a node, or
   * a module for the top level). Refines, augments and deviations of such
   * a node are ignored, as libyang does, rather than reported.
   */
  isDisabled(parent: object, name: string): boolean {
    return this.#disabled.get(parent)?.has(name) ?? false;
  }

  /**
   * Whether an if-feature (on a node, `uses`, `refine` or `augment`) or a
   * `deviate not-supported` removed something from `parent` (a node, or a
   * module for the top level), so that a name missing from it may be meant.
   */
  isIncomplete(parent: object): boolean {
    return this.#incomplete.has(parent);
  }

  #node(s: Statement, bc: BuildContext): MNode | undefined {
    if (!this.#enabled(s, bc)) return undefined;
    switch (s.keyword) {
      case 'container': {
        const node = this.#base('container', s, bc);
        const presence = substatement(s, 'presence')?.argument;
        if (presence !== undefined) node.presence = presence;
        node.children = this.#body(s.substatements, this.#inner(s, bc, node));
        return node;
      }
      case 'list': {
        const node = this.#base('list', s, bc);
        node.keys = [];
        node.unique = [];
        this.#elements(node, s);
        const key = substatement(s, 'key');
        if (key?.argument !== undefined) this.#keyNames.set(node, { names: key.argument.trim().split(/\s+/), at: key });
        this.#uniqueArgs.set(node, substatements(s, 'unique'));
        node.children = this.#body(s.substatements, this.#inner(s, bc, node));
        this.#lists.push(node);
        return node;
      }
      case 'leaf':
      case 'leaf-list': {
        const node = this.#base(s.keyword, s, bc);
        const typeStatement = substatement(s, 'type');
        const type = typeStatement === undefined ? undefined : this.#types.resolve(typeStatement, { file: bc.scope.file, statement: s, parent: bc.scope });
        if (type === undefined) return undefined;
        node.type = instantiate(type);
        const units = substatement(s, 'units')?.argument ?? type.typedef?.units;
        if (units !== undefined) node.units = units;
        if (s.keyword === 'leaf') {
          node.mandatory = substatement(s, 'mandatory')?.argument === 'true';
          node.isKey = false;
          const dflt = substatement(s, 'default')?.argument;
          if (dflt !== undefined) node.default = dflt;
        } else {
          node.defaults = substatements(s, 'default').map((d) => d.argument ?? '');
          this.#elements(node, s);
        }
        this.#defaultFile.set(node, bc.scope.file);
        this.#leaves.push(node);
        return node;
      }
      case 'choice': {
        const node = this.#base('choice', s, bc);
        node.mandatory = substatement(s, 'mandatory')?.argument === 'true';
        node.children = this.#cases(s.substatements, this.#inner(s, bc, node));
        const dflt = substatement(s, 'default');
        if (dflt !== undefined) this.#defaultCase.set(node, dflt);
        this.#choices.push(node);
        return node;
      }
      case 'anydata':
      case 'anyxml': {
        const node = this.#base(s.keyword, s, bc);
        node.mandatory = substatement(s, 'mandatory')?.argument === 'true';
        return node;
      }
      default:
        return undefined;
    }
  }

  #elements(node: MNode, s: Statement): void {
    const min = substatement(s, 'min-elements')?.argument;
    const max = substatement(s, 'max-elements')?.argument;
    node.minElements = min === undefined ? 0 : Number(min);
    node.maxElements = max === undefined || max === 'unbounded' ? undefined : Number(max);
    node.orderedBy = substatement(s, 'ordered-by')?.argument === 'user' ? 'user' : 'system';
    if (node.maxElements !== undefined && node.minElements > node.maxElements) {
      this.ctx.error('min-above-max', `min-elements ${node.minElements} is greater than max-elements ${node.maxElements}`, s);
    }
  }

  /** The cases of a choice: explicit `case` statements, and shorthand data definitions wrapped in an implicit case. */
  #cases(statements: readonly Statement[], bc: BuildContext): MNode[] {
    const out: MNode[] = [];
    for (const s of statements) {
      if (s.keyword === 'case') {
        if (!this.#enabled(s, bc)) continue;
        const c = this.#base('case', s, bc);
        c.shorthand = false;
        c.children = this.#body(s.substatements, this.#inner(s, bc, c));
        out.push(c);
      } else if (SHORTHAND.has(s.keyword)) {
        if (!this.#enabled(s, bc)) continue;
        const c = this.#base('case', s, bc);
        c.shorthand = true;
        c.when = [];
        c.must = [];
        c.extensions = [];
        c.ifFeatures = [];
        const child = this.#node(s, { ...bc, parent: c });
        if (child === undefined) continue;
        c.children = [child];
        out.push(c);
      }
    }
    return out;
  }

  #operation(s: Statement, bc: BuildContext): MNode | undefined {
    if (!this.#enabled(s, bc)) return undefined;
    const node = this.#base(s.keyword as 'rpc' | 'action', s, { ...bc, inOperation: true });
    const inner = this.#inner(s, bc, node, { inOperation: true, config: false });
    const io = (kind: 'input' | 'output'): MNode => {
      const st = substatement(s, kind);
      const n = this.#base(kind, st ?? s, inner);
      n.name = kind;
      n.when = [];
      n.ifFeatures = [];
      if (st === undefined) n.status = 'current';
      n.extensions = st === undefined ? [] : n.extensions;
      n.must = st === undefined ? [] : n.must;
      if (st === undefined) {
        delete (n as { description?: string }).description;
        delete (n as { reference?: string }).reference;
      }
      n.children = st === undefined ? [] : this.#body(st.substatements, this.#inner(st, inner, n));
      return n;
    };
    const input = io('input');
    const output = io('output');
    node.input = input as unknown as InputNode;
    node.output = output as unknown as InputNode;
    node.children = [input, output];
    return node;
  }

  #notification(s: Statement, bc: BuildContext): MNode | undefined {
    if (!this.#enabled(s, bc)) return undefined;
    const node = this.#base('notification', s, { ...bc, inOperation: true });
    node.children = this.#body(s.substatements, this.#inner(s, bc, node, { inOperation: true, config: false }));
    return node;
  }

  // ---------------------------------------------------------------------------
  // uses, refine, augment

  #uses(s: Statement, bc: BuildContext): MNode[] {
    if (!this.ctx.enabled(s, bc.scope.file, bc.scope)) {
      this.#incomplete.add(bc.parent ?? bc.module);
      return [];
    }
    const ref = s.argument ?? '';
    const def = this.ctx.lookup('grouping', ref, bc.scope, s);
    if (def === undefined) {
      this.ctx.error('unknown-grouping', `grouping '${ref}' is not defined`, s);
      return [];
    }
    if (bc.groupings.includes(def.statement)) {
      this.ctx.error('grouping-cycle', `grouping '${ref}' uses itself`, s);
      return [];
    }
    const inner: BuildContext = {
      ...bc,
      scope: { file: def.scope.file, statement: def.statement, parent: def.scope },
      groupings: [...bc.groupings, def.statement],
    };
    const nodes = this.#body(def.statement.substatements, inner);
    const usesFeatures = ifFeaturesOf(s);
    for (const n of nodes) n.ifFeatures = [...n.ifFeatures, ...usesFeatures];
    const when = substatement(s, 'when');
    if (when !== undefined) {
      const w: WhenCondition = this.ctx.when(when, bc.scope.file, 'uses');
      for (const n of nodes) n.when = [...n.when, w];
    }
    let result = nodes;
    const root: object = bc.parent ?? bc.module;
    for (const r of substatements(s, 'refine')) {
      const target = this.#descendant(result, r.argument ?? '', bc.scope.file, root);
      if (target === null) continue;
      if (target === undefined) {
        this.ctx.error('refine-target-not-found', `refine target '${r.argument ?? ''}' is not in grouping '${ref}'`, r);
        continue;
      }
      if (!this.#refine(target, r, bc.scope.file)) {
        this.#incomplete.add(target.parent ?? bc.module);
        result = removeNode(result, target);
      }
    }
    for (const a of substatements(s, 'augment')) {
      const target = this.#descendant(result, a.argument ?? '', bc.scope.file, root);
      if (target === null) continue;
      if (target === undefined) {
        this.ctx.error('augment-target-not-found', `augment target '${a.argument ?? ''}' is not in grouping '${ref}'`, a);
        continue;
      }
      this.augment(target, a, bc.scope, bc.module);
    }
    return result;
  }

  /**
   * Finds a node by descendant schema node identifier among `roots` and
   * their descendants. Null when an if-feature removed a node on the way.
   */
  #descendant(roots: readonly MNode[], path: string, file: LoadedFile, root: object): MNode | undefined | null {
    let candidates: readonly MNode[] = roots;
    let found: MNode | undefined;
    let parent: object = root;
    for (const step of path.split('/')) {
      const parts = splitRef(step.trim());
      if (parts === undefined) return undefined;
      const named = candidates.filter((c) => c.name === parts.name);
      if (named.length > 1) {
        const want = this.ctx.moduleFor(parts.prefix, file)?.name;
        found = named.find((c) => c.module.name === want) ?? named[0];
      } else {
        found = named[0];
      }
      if (found === undefined) return this.isDisabled(parent, parts.name) ? null : undefined;
      parent = found;
      candidates = found.children;
    }
    return found;
  }

  /** Applies a refine (RFC 7950 §7.13.2). Returns false when an if-feature removes the node. */
  #refine(target: MNode, r: Statement, file: LoadedFile): boolean {
    const t = target;
    const allowed = (props: Record<string, readonly string[]>): void => {
      for (const sub of r.substatements) {
        const kinds = props[sub.keyword];
        if (kinds !== undefined && !kinds.includes(target.kind)) {
          this.ctx.error('invalid-refine', `'${sub.keyword}' can't refine a ${target.kind}`, sub);
        }
      }
    };
    allowed({
      presence: ['container'],
      default: ['leaf', 'leaf-list', 'choice'],
      mandatory: ['leaf', 'choice', 'anydata', 'anyxml'],
      'min-elements': ['list', 'leaf-list'],
      'max-elements': ['list', 'leaf-list'],
      must: ['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml'],
      config: ['container', 'list', 'leaf', 'leaf-list', 'choice', 'anydata', 'anyxml'],
    });
    const doc = docOf(r);
    if (doc.description !== undefined) t.description = doc.description;
    if (doc.reference !== undefined) t.reference = doc.reference;
    const config = substatement(r, 'config');
    if (config !== undefined) {
      this.#explicitConfig.add(target);
      setConfig(target, config.argument === 'true', this.#explicitConfig);
    }
    const presence = substatement(r, 'presence')?.argument;
    if (presence !== undefined && target.kind === 'container') t.presence = presence;
    const mandatory = substatement(r, 'mandatory')?.argument;
    if (mandatory !== undefined && 'mandatory' in t) t.mandatory = mandatory === 'true';
    const defaults = substatements(r, 'default');
    if (defaults.length > 0) {
      if (target.kind === 'leaf' && defaults[0]!.argument !== undefined) t.default = defaults[0]!.argument;
      else if (target.kind === 'leaf-list') t.defaults = defaults.map((d) => d.argument ?? '');
      else if (target.kind === 'choice') this.#defaultCase.set(target, defaults[0]!);
      this.#defaultFile.set(target, file);
    }
    const min = substatement(r, 'min-elements')?.argument;
    if (min !== undefined && 'minElements' in t) t.minElements = Number(min);
    const max = substatement(r, 'max-elements')?.argument;
    if (max !== undefined && 'maxElements' in t) t.maxElements = max === 'unbounded' ? undefined : Number(max);
    target.must = [...target.must, ...this.ctx.mustsOf(r, file)];
    target.extensions = [...target.extensions, ...this.ctx.extensionsOf(r, file)];
    target.ifFeatures = [...target.ifFeatures, ...ifFeaturesOf(r)];
    return this.ctx.enabled(r, file);
  }

  /** Adds an augment's nodes to a target (RFC 7950 §7.17), and returns them. */
  augment(target: MNode, a: Statement, scope: Scope, module: MutableModule): MNode[] {
    if (!this.ctx.enabled(a, scope.file, scope)) {
      this.#incomplete.add(target);
      return [];
    }
    const allowedTargets = ['container', 'list', 'choice', 'case', 'input', 'output', 'notification'];
    if (!allowedTargets.includes(target.kind)) {
      this.ctx.error('invalid-augment-target', `an augment can't target a ${target.kind}`, a);
      return [];
    }
    this.ctx.checkStatus(referrer(a, scope, scope.file), describeNode(target), a.location);
    const inOperation = isInOperation(target);
    const bc: BuildContext = {
      scope: { file: scope.file, statement: a, parent: scope },
      module,
      parent: target,
      config: inOperation ? false : target.config,
      inOperation,
      groupings: [],
    };
    let added: MNode[];
    if (target.kind === 'choice') {
      added = this.#cases(a.substatements, bc);
      for (const s of substatements(a, 'uses')) this.ctx.error('invalid-augment', "an augment of a choice can't contain 'uses' directly; wrap it in a case", s);
    } else {
      added = this.#body(a.substatements, bc);
      for (const s of substatements(a, 'case')) this.ctx.error('invalid-augment', `'case' can only augment a choice, not a ${target.kind}`, s);
    }
    const when = substatement(a, 'when');
    if (when !== undefined) {
      const w: WhenCondition = this.ctx.when(when, scope.file, 'augment');
      for (const n of added) n.when = [...n.when, w];
    }
    const features = ifFeaturesOf(a);
    for (const n of added) n.ifFeatures = [...n.ifFeatures, ...features.filter((f) => !n.ifFeatures.includes(f))];
    target.children.push(...added);
    return added;
  }

  // ---------------------------------------------------------------------------
  // Deviations (RFC 7950 §7.20.3)

  deviate(target: MNode, deviation: Statement, file: LoadedFile, remove: (n: MNode) => void): void {
    for (const d of substatements(deviation, 'deviate')) {
      const t = target as MNode & Record<string, unknown>;
      switch (d.argument) {
        case 'not-supported':
          if (d.substatements.some((s) => !isExtension(s))) this.ctx.error('invalid-deviate', "'deviate not-supported' takes no substatements", d);
          this.#removed.add(target);
          this.#incomplete.add(target.parent ?? target.module);
          remove(target);
          return;
        case 'add':
        case 'replace': {
          const replace = d.argument === 'replace';
          const single = (keyword: string, prop: string, value: unknown): void => {
            const has = t[prop] !== undefined && !(keyword === 'config' && !this.#explicitConfig.has(target));
            if (replace && t[prop] === undefined && keyword !== 'config') this.ctx.error('invalid-deviate', `'deviate replace' of '${keyword}', but the node has none`, d);
            if (!replace && has && keyword !== 'mandatory') this.ctx.error('invalid-deviate', `'deviate add' of '${keyword}', but the node already has one`, d);
            t[prop] = value;
          };
          const config = substatement(d, 'config');
          if (config !== undefined) {
            single('config', 'config', config.argument === 'true');
            this.#explicitConfig.add(target);
            setConfig(target, config.argument === 'true', this.#explicitConfig);
          }
          const units = substatement(d, 'units')?.argument;
          if (units !== undefined) single('units', 'units', units);
          const mandatory = substatement(d, 'mandatory')?.argument;
          if (mandatory !== undefined) t.mandatory = mandatory === 'true';
          const min = substatement(d, 'min-elements')?.argument;
          if (min !== undefined) t.minElements = Number(min);
          const max = substatement(d, 'max-elements')?.argument;
          if (max !== undefined) t.maxElements = max === 'unbounded' ? undefined : Number(max);
          const defaults = substatements(d, 'default');
          if (defaults.length > 0) {
            if (target.kind === 'leaf') single('default', 'default', defaults[0]!.argument);
            else if (target.kind === 'leaf-list') t.defaults = replace ? defaults.map((x) => x.argument ?? '') : [...(t.defaults as string[]), ...defaults.map((x) => x.argument ?? '')];
            else if (target.kind === 'choice') this.#defaultCase.set(target, defaults[0]!);
            this.#defaultFile.set(target, file);
          }
          const type = substatement(d, 'type');
          if (type !== undefined) {
            if (!replace) this.ctx.error('invalid-deviate', "'type' can only be replaced, not added", type);
            const resolved = this.#types.resolve(type, { file, statement: d, parent: { file } });
            if (resolved !== undefined) t.type = instantiate(resolved);
          }
          if (!replace) {
            target.must = [...target.must, ...this.ctx.mustsOf(d, file)];
            const unique = substatements(d, 'unique');
            if (unique.length > 0 && target.kind === 'list') this.#uniqueArgs.set(target, [...(this.#uniqueArgs.get(target) ?? []), ...unique]);
          }
          break;
        }
        case 'delete': {
          if (substatement(d, 'units') !== undefined) delete t.units;
          const defaults = substatements(d, 'default').map((x) => x.argument);
          if (defaults.length > 0) {
            if (target.kind === 'leaf') delete t.default;
            else if (target.kind === 'leaf-list') t.defaults = (t.defaults as string[]).filter((v) => !defaults.includes(v));
          }
          const musts = substatements(d, 'must').map((m) => m.argument);
          if (musts.length > 0) target.must = target.must.filter((m) => !musts.includes(m.text));
          const unique = substatements(d, 'unique').map((u) => u.argument);
          if (unique.length > 0 && target.kind === 'list') {
            this.#uniqueArgs.set(target, (this.#uniqueArgs.get(target) ?? []).filter((u) => !unique.includes(u.argument)));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Modules named by the steps of leafref paths in the nodes built so far. */
  leafrefModules(): Set<string> {
    const out = new Set<string>();
    const visit = (leaf: MNode, t: YangType): void => {
      if (t.builtin === 'union') for (const m of t.types ?? []) visit(leaf, m);
      if (t.builtin !== 'leafref' || t.path === undefined) return;
      for (const step of t.path.steps) {
        const name = step.prefix === undefined ? leaf.module.name : t.path.prefixes.get(step.prefix);
        if (name !== undefined) out.add(name);
      }
    };
    for (const leaf of this.#leaves) if (leaf.type !== undefined) visit(leaf, leaf.type);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Finishing

  finish(roots: () => MNode[]): void {
    const live = (n: MNode): boolean => this.#live(n);
    for (const list of this.#lists.filter(live)) this.#finishList(list);
    for (const choice of this.#choices.filter(live)) this.#finishChoice(choice);
    this.#checkAugmentMandatory();
    const leaves = this.#leaves.filter(live);
    for (const leaf of leaves) this.#resolveLeafrefs(leaf, roots);
    for (const leaf of leaves) this.#checkDefaults(leaf);
  }

  /** Whether a node is still in the schema: no deviation removed it or an ancestor. */
  #live(node: MNode): boolean {
    for (let n: MNode | undefined = node; n !== undefined; n = n.parent) if (this.#removed.has(n)) return false;
    return true;
  }

  #finishList(list: MNode): void {
    const l = list;
    const keys = this.#keyNames.get(list);
    if (keys === undefined) {
      // Lists in structures needn't have keys (RFC 8791 §2.1, RFC 8040 §8).
      if (list.config && !isInOperation(list) && this.structureRoots(list) === undefined) this.ctx.error('missing-key', `config list '${list.name}' needs a key`, list.statement);
    } else {
      const found: MNode[] = [];
      for (const name of keys.names) {
        const leaf = list.children.find((c) => c.name === name && c.kind === 'leaf');
        if (leaf === undefined) {
          this.ctx.error('unknown-key', `key '${name}' is not a leaf directly in list '${list.name}'`, keys.at);
          continue;
        }
        if (found.includes(leaf)) {
          this.ctx.error('duplicate-key', `key '${name}' is listed twice`, keys.at);
          continue;
        }
        if (leaf.config !== list.config && !isInOperation(list)) this.ctx.error('key-config', `key '${name}' must have the same config value as list '${list.name}'`, leaf.statement);
        if (leaf.type?.builtin === 'empty' && leaf.module.yangVersion === '1') this.ctx.error('empty-key', `key '${name}' can't be of type empty in yang-version 1`, leaf.statement);
        leaf.isKey = true;
        found.push(leaf);
      }
      l.keys = found as unknown as LeafNode[];
    }
    const unique: LeafNode[][] = [];
    for (const u of this.#uniqueArgs.get(list) ?? []) {
      const set: LeafNode[] = [];
      for (const path of (u.argument ?? '').trim().split(/\s+/)) {
        let node: MNode | undefined = list;
        for (const step of path.split('/')) {
          const parts = splitRef(step);
          node = parts === undefined ? undefined : dataChildren(node).find((c) => c.name === parts.name);
          if (node === undefined) break;
        }
        if (node?.kind !== 'leaf') this.ctx.error('unknown-unique', `unique '${path}' is not a leaf in list '${list.name}'`, u);
        else set.push(node as unknown as LeafNode);
      }
      unique.push(set);
    }
    l.unique = unique;
  }

  #finishChoice(choice: MNode): void {
    const d = this.#defaultCase.get(choice);
    if (d === undefined) return;
    const c = choice;
    const found = choice.children.find((x) => x.name === d.argument);
    if (found === undefined) {
      this.ctx.error('unknown-default-case', `default case '${d.argument ?? ''}' is not a case of choice '${choice.name}'`, d);
      return;
    }
    if (c.mandatory) this.ctx.error('mandatory-with-default', `choice '${choice.name}' can't be mandatory and have a default`, d);
    c.defaultCase = found as CaseNode;
    // RFC 7950 §7.9.3: no mandatory nodes directly under the default case.
    // A nested choice that isn't itself mandatory hides its cases' nodes.
    for (const child of found.children) {
      const m = this.#mandatoryNode(child);
      if (m !== undefined) {
        this.ctx.error('mandatory-in-default-case', `${describeMandatory(m, child)} is in default case '${found.name}' of choice '${choice.name}'`, m.statement);
      }
    }
  }

  /**
   * An augment of a node in another module must not add mandatory config
   * nodes (RFC 7950 §7.17, RFC 6020 §7.15). Checked once deviations and
   * refines are applied, as libyang does. State data, input, output and
   * notifications aren't checked in either version, as libyang and pyang
   * agree. A YANG 1.1 augment may add them under its own `when`. YANG 1.0
   * has no such exception, but libyang allows it, so that's a warning. A new
   * case of a choice isn't a mandatory node, whatever its contents.
   */
  #checkAugmentMandatory(): void {
    for (const module of this.ctx.compiled.values()) {
      if (!module.implemented) continue;
      for (const a of module.augments) {
        const target = a.target as unknown as MNode;
        const statement = a.statement!;
        if (target.module === module) continue;
        const when = substatement(statement, 'when') !== undefined;
        if (when && module.yangVersion === '1.1') continue;
        for (const node of a.nodes as unknown as MNode[]) {
          if (!this.#live(node)) continue;
          const m = this.#mandatoryNode(node);
          if (m === undefined || !m.config) continue;
          const message = `augment '${a.path}' adds ${describeMandatory(m, node)} to module ${target.module.name}`;
          // libyang accepts a YANG 1.0 augment with `when`, though RFC 6020 doesn't: a warning.
          if (when) this.ctx.warning('augment-adds-mandatory', `${message}; YANG 1.0 doesn't allow it even under 'when'`, m.statement);
          else this.ctx.error('augment-adds-mandatory', `${message}${module.yangVersion === '1.1' ? "; make the augment conditional with 'when'" : ''}`, m.statement);
        }
      }
    }
  }

  /**
   * The node that makes `node` a mandatory node (RFC 7950 §3): itself, or for
   * a container without `presence`, the first mandatory node among its children.
   */
  #mandatoryNode(node: MNode): MNode | undefined {
    if (this.#removed.has(node)) return undefined;
    switch (node.kind) {
      case 'leaf':
      case 'choice':
      case 'anydata':
      case 'anyxml':
        return node.mandatory === true ? node : undefined;
      case 'list':
      case 'leaf-list':
        return (node.minElements ?? 0) > 0 ? node : undefined;
      case 'container':
        if (node.presence !== undefined) return undefined;
        for (const c of node.children) {
          const m = this.#mandatoryNode(c);
          if (m !== undefined) return m;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  #resolveLeafrefs(leaf: MNode, roots: () => MNode[]): void {
    const visit = (t: YangType): void => {
      if (t.builtin === 'union') for (const m of t.types ?? []) visit(m);
      if (t.builtin !== 'leafref' || t.path === undefined) return;
      const target = this.#followPath(leaf, t, roots);
      if (target === undefined) return;
      (t as { target?: LeafNode | LeafListNode }).target = target;
      this.ctx.checkStatus(describeNode(leaf), describeNode(target as unknown as MNode), leaf.statement.location);
    };
    if (leaf.type !== undefined) visit(leaf.type);
  }

  #followPath(leaf: MNode, t: YangType, roots: () => MNode[]): LeafNode | LeafListNode | undefined {
    const path = t.path!;
    let candidates: MNode[];
    const structure = this.structureRoots(leaf);
    if (path.absolute) {
      candidates = structure ?? roots();
    } else {
      let node: MNode | undefined = leaf;
      for (let i = 0; i < path.up && node !== undefined; i++) node = dataParent(node);
      if (node === undefined && path.up > 0) {
        // Climbing past the top of the tree leaves us at the root.
        candidates = structure ?? roots();
      } else {
        candidates = node === undefined ? (structure ?? roots()) : dataChildren(node);
      }
    }
    let found: MNode | undefined;
    let first = true;
    const predicates = path.text.includes('[') ? leafrefPredicates(path.text) : undefined;
    for (const [i, step] of path.steps.entries()) {
      const moduleName = step.prefix === undefined ? leaf.module.name : path.prefixes.get(step.prefix);
      found = candidates.find((c) => c.name === step.name && c.module.name === moduleName);
      // An absolute path in a structure may also lead into datastore data, as published modules do.
      if (found === undefined && first && path.absolute && structure !== undefined) found = roots().find((c) => c.name === step.name && c.module.name === moduleName);
      first = false;
      if (found === undefined) {
        this.ctx.error('leafref-target-not-found', `leafref path ${JSON.stringify(path.text)} of '${leaf.name}': '${step.prefix === undefined ? '' : `${step.prefix}:`}${step.name}' was not found`, leaf.statement);
        return undefined;
      }
      const stepPredicates = predicates?.[i] ?? [];
      if (stepPredicates.length > 0 && !this.#checkPredicates(leaf, path.text, path.prefixes, found, stepPredicates, structure ?? roots())) return undefined;
      candidates = dataChildren(found);
    }
    if (found?.kind !== 'leaf' && found?.kind !== 'leaf-list') {
      this.ctx.error('leafref-target-not-leaf', `leafref path ${JSON.stringify(path.text)} of '${leaf.name}' must point to a leaf or leaf-list`, leaf.statement);
      return undefined;
    }
    return found as LeafNode | LeafListNode;
  }

  /**
   * Checks the predicates of one leafref path step against the schema, as
   * libyang does: the step must be a list, each key one of its keys and named
   * once, and each `current()/../path` must lead to a leaf. Reports the first
   * problem and returns false.
   */
  #checkPredicates(leaf: MNode, text: string, prefixes: ReadonlyMap<string, string>, list: MNode, predicates: readonly PathPredicate[], top: MNode[]): boolean {
    const fail = (problem: string): false => {
      this.ctx.error('leafref-invalid-predicate', `leafref path ${JSON.stringify(text)} of '${leaf.name}': ${problem}`, leaf.statement);
      return false;
    };
    const show = (n: PathName): string => (n.prefix === undefined ? n.name : `${n.prefix}:${n.name}`);
    const find = (among: MNode[], n: PathName): MNode | undefined => {
      const moduleName = n.prefix === undefined ? leaf.module.name : prefixes.get(n.prefix);
      return among.find((c) => c.name === n.name && c.module.name === moduleName);
    };
    if (list.kind !== 'list') return fail(`'${list.name}' has a predicate but is a ${list.kind}, not a list`);
    const seen = new Set<MNode>();
    for (const p of predicates) {
      const key = find(dataChildren(list), p.key);
      if (key === undefined) return fail(`'${show(p.key)}' in a predicate is not a child of list '${list.name}'`);
      if (key.isKey !== true) return fail(`'${show(p.key)}' in a predicate is not a key of list '${list.name}'`);
      if (seen.has(key)) return fail(`key '${show(p.key)}' of list '${list.name}' is in two predicates`);
      seen.add(key);
      // current() is the leaf itself.
      let at: MNode | undefined = leaf;
      for (let i = 0; i < p.up; i++) {
        if (at === undefined) return fail(`the predicate on '${show(p.key)}' climbs above the top of the tree`);
        at = dataParent(at);
      }
      let target: MNode | undefined;
      let among = at === undefined ? top : dataChildren(at);
      for (const n of p.steps) {
        target = find(among, n);
        if (target === undefined) return fail(`'${show(n)}' in the predicate on '${show(p.key)}' was not found`);
        among = dataChildren(target);
      }
      if (target?.kind !== 'leaf') return fail(`the predicate on '${show(p.key)}' must lead to a leaf, not a ${target?.kind ?? 'node'}`);
    }
    return true;
  }

  #mainFile(module: CompiledModule): LoadedFile {
    return this.ctx.loaded.get(this.ctx.keyOf(module))!.files[0]!;
  }

  /**
   * Typed default values, once the schema exists (an instance-identifier
   * default needs it). Prefixes resolve in the file the default is written in.
   */
  typeDefaults(schema: Schema): void {
    for (const leaf of this.#leaves) {
      if (leaf.type === undefined || !this.#live(leaf)) continue;
      const file = this.#defaultFile.get(leaf) ?? this.#mainFile(leaf.module);
      const scope = { format: 'xml' as const, schema, module: (p: string) => this.ctx.moduleFor(p, file), unprefixed: this.ctx.compiled.get(file.module.key) };
      const parse = (text: string): TypedValue | undefined => {
        const v = parseText(leaf.type!, text, scope);
        return typeof v === 'string' ? undefined : v;
      };
      if (leaf.kind === 'leaf') {
        const v = leaf.default === undefined ? undefined : parse(leaf.default);
        if (v !== undefined) leaf.defaultValue = v;
        else delete leaf.defaultValue;
      } else if (leaf.kind === 'leaf-list') {
        leaf.defaultValues = (leaf.defaults ?? []).map(parse).filter((v) => v !== undefined);
      }
    }
  }

  #checkDefaults(leaf: MNode): void {
    const type = leaf.type;
    if (type === undefined) return;
    if (hasLeafrefCycle(type)) {
      this.ctx.error('leafref-cycle', `the leafref of '${leaf.name}' leads back to itself`, leaf.statement);
      return;
    }
    const file = this.#defaultFile.get(leaf) ?? this.ctx.loaded.get(this.ctx.keyOf(leaf.module))!.files[0]!;
    const context = {
      resolveIdentity: (prefix: string | undefined, name: string) => this.ctx.resolveIdentity(prefix === undefined ? name : `${prefix}:${name}`, file, leaf.statement),
      inModule: true,
    };
    const check = (value: string, what: string): void => {
      if (type.builtin === 'empty') {
        this.ctx.error('invalid-default', `'${leaf.name}' is of type empty and can't have a default`, leaf.statement);
        return;
      }
      const problem = checkValue(type, value, context);
      if (problem !== undefined) this.ctx.error('invalid-default', `${what} of '${leaf.name}': ${problem}`, leaf.statement);
    };
    if (leaf.kind === 'leaf') {
      if (leaf.default !== undefined) {
        if (leaf.mandatory === true) this.ctx.error('mandatory-with-default', `leaf '${leaf.name}' can't be mandatory and have a default`, leaf.statement);
        check(leaf.default, 'the default');
      } else if (type.typedef?.default !== undefined && leaf.mandatory !== true && leaf.isKey !== true) {
        // A typedef's default applies to leaves that don't set their own (RFC 7950 §7.6.1).
        leaf.default = type.typedef.default;
        this.#defaultFile.set(leaf, this.#mainFile(type.typedef.module));
      }
    } else {
      const defaults = leaf.defaults ?? [];
      for (const d of defaults) check(d, 'a default');
      if (defaults.length === 0 && leaf.minElements === 0 && type.typedef?.default !== undefined && leaf.module.yangVersion === '1.1') {
        // RFC 7950 §7.7.2: the type's default applies when the leaf-list has none and min-elements is 0.
        leaf.defaults = [type.typedef.default];
        this.#defaultFile.set(leaf, this.#mainFile(type.typedef.module));
      }
    }
  }
}

function ifFeaturesOf(s: Statement): string[] {
  return substatements(s, 'if-feature').map((f) => f.argument ?? '');
}

function hasLeafrefCycle(t: YangType): boolean {
  const seen = new Set<object>();
  const walk = (type: YangType): boolean => {
    if (type.builtin === 'union') return (type.types ?? []).some(walk);
    if (type.builtin !== 'leafref' || type.target === undefined) return false;
    if (seen.has(type.target)) return true;
    seen.add(type.target);
    return walk(type.target.type);
  };
  return walk(t);
}

/** The data parent: skips choice, case, input and output, which don't appear in data. */
export function dataParent(node: MNode): MNode | undefined {
  let p = node.parent;
  while (p !== undefined && TRANSPARENT.has(p.kind)) p = p.parent;
  return p;
}

/** Data children: looks through choice, case, input and output. */
export function dataChildren(node: MNode): MNode[] {
  const out: MNode[] = [];
  for (const c of node.children) {
    if (TRANSPARENT.has(c.kind)) out.push(...dataChildren(c));
    else out.push(c);
  }
  return out;
}

function dataDescendants(node: MNode): MNode[] {
  return dataChildren(node);
}

/** A schema node as one side of a status reference, with its effective status. */
function describeNode(node: MNode): StatusParty {
  return { status: nodeStatus(node), module: node.module.name, describe: `${node.kind} '${node.name}'` };
}

function isInOperation(node: MNode): boolean {
  for (let n: MNode | undefined = node; n !== undefined; n = n.parent) {
    if (n.kind === 'rpc' || n.kind === 'action' || n.kind === 'notification' || n.kind === 'input' || n.kind === 'output') return true;
  }
  return false;
}

function setConfig(node: MNode, value: boolean, explicit: WeakSet<MNode>): void {
  node.config = value;
  for (const c of node.children) if (!explicit.has(c)) setConfig(c, value, explicit);
}

function removeNode(list: MNode[], target: MNode): MNode[] {
  if (list.includes(target)) return list.filter((n) => n !== target);
  const parent = target.parent;
  if (parent !== undefined) parent.children = parent.children.filter((n) => n !== target);
  return list;
}

export type { MNode };

/** Names a mandatory node and why it is one, for messages, and the container it makes mandatory, if any. */
function describeMandatory(n: MNode, top: MNode): string {
  const what = n.kind === 'list' || n.kind === 'leaf-list' ? `${n.kind} '${n.name}' with min-elements ${n.minElements ?? 0}` : `mandatory ${n.kind} '${n.name}'`;
  return n === top ? what : `${what} (in container '${top.name}')`;
}
