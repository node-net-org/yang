/**
 * A compiled schema: a set of modules with their data trees, operations and
 * notifications resolved, plus the diagnostics found while compiling.
 */

import type { Diagnostic } from '../location.js';
import type { CompiledModule, DataNode, NotificationNode, RpcNode, SchemaNode, StructureDefinition } from './model.js';
import { SchemaQuery, type NodeInfo, type PathCompletion, type QueryOptions } from './query.js';

const TRANSPARENT = new Set(['choice', 'case', 'input', 'output']);

const DATASTORES = 'ietf-datastores';

export interface DatastoreOptions {
  /**
   * Whether the datastore holds state data (config false nodes). By default
   * only `<operational>` and dynamic datastores do (RFC 8342 §5): every
   * other datastore, including ones this library doesn't know such as
   * RFC 10016's `<system>`, is a configuration datastore.
   */
  readonly state?: boolean;
}

export class Schema {
  /**
   * Every loaded module, implemented or only imported, by name. When a
   * module is loaded in more than one revision, this has the primary one:
   * the implemented revision, or the one imports without a revision date
   * use. {@link allModules} has them all.
   */
  readonly modules: ReadonlyMap<string, CompiledModule>;
  /** Every loaded module, in every revision loaded. */
  readonly allModules: readonly CompiledModule[];
  /** Problems found while loading and compiling, errors and warnings. */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The datastore this schema describes (RFC 8342), as an identity
   * qualified by module name: `ietf-datastores:running`. Undefined for a
   * schema that isn't tied to one, which accepts any data.
   */
  readonly datastore: string | undefined;
  /**
   * Whether data for this schema may hold state data (config false nodes).
   * False for a configuration datastore: the codecs then reject state data,
   * and queries leave it out.
   */
  readonly holdsState: boolean;

  /**
   * @param modules compiled modules by key: the name for a module's primary
   *   revision, `name@revision` for other revisions
   */
  constructor(modules: ReadonlyMap<string, CompiledModule>, diagnostics: readonly Diagnostic[], datastore?: { readonly name: string; readonly state: boolean }) {
    this.modules = new Map([...modules].filter(([key, m]) => key === m.name));
    this.allModules = [...modules.values()];
    this.#byKey = modules;
    this.diagnostics = diagnostics;
    this.datastore = datastore?.name;
    this.holdsState = datastore?.state ?? true;
  }

  readonly #byKey: ReadonlyMap<string, CompiledModule>;

  /**
   * The same schema, for one datastore: `running`, `operational`, or any
   * datastore identity as `module:name` (a bare name is taken to be in
   * ietf-datastores). The modules are shared, not compiled again.
   */
  forDatastore(datastore: string, options: DatastoreOptions = {}): Schema {
    const name = datastore.includes(':') ? datastore : `${DATASTORES}:${datastore}`;
    return new Schema(this.#byKey, this.diagnostics, { name, state: options.state ?? this.#datastoreHoldsState(name) });
  }

  #datastoreHoldsState(name: string): boolean {
    if (name === `${DATASTORES}:operational`) return true;
    const [moduleName, id] = name.split(':') as [string, string];
    const identity = this.module(moduleName)?.identities.get(id);
    const ds = this.module(DATASTORES);
    if (identity === undefined || ds === undefined) return false;
    return ['operational', 'dynamic'].some((b) => {
      const base = ds.identities.get(b);
      return base !== undefined && (base === identity || base.derived.has(identity));
    });
  }

  /** The error diagnostics only. A schema with errors may be incomplete. */
  get errors(): Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === 'error');
  }

  /** A module by name: the primary revision, or the given one. */
  module(name: string, revision?: string): CompiledModule | undefined {
    const primary = this.modules.get(name);
    if (revision === undefined || primary?.revision === revision) return primary;
    return this.allModules.find((m) => m.name === name && m.revision === revision);
  }

  /** Modules whose nodes are part of the schema. */
  get implemented(): CompiledModule[] {
    return [...this.modules.values()].filter((m) => m.implemented);
  }

  /** Top-level data nodes of every implemented module. */
  get dataNodes(): DataNode[] {
    return this.implemented.flatMap((m) => m.dataNodes);
  }

  get rpcs(): RpcNode[] {
    return this.implemented.flatMap((m) => m.rpcs);
  }

  get notifications(): NotificationNode[] {
    return this.implemented.flatMap((m) => m.notifications);
  }

  /** YANG data structures (`sx:structure`, `rc:yang-data`) of every implemented module. */
  get structures(): StructureDefinition[] {
    return this.implemented.flatMap((m) => [...m.structures.values()]);
  }

  /** A structure by `module:name`. */
  structure(name: string): StructureDefinition | undefined {
    const colon = name.indexOf(':');
    if (colon === -1) return this.structures.find((s) => s.name === name);
    const m = this.module(name.slice(0, colon));
    return m?.implemented === true ? m.structures.get(name.slice(colon + 1)) : undefined;
  }

  /**
   * Finds a node by data path, in the RFC 7951 style: steps separated by
   * `/`, the first step and any step that changes namespace prefixed with a
   * module name, as in `/ietf-interfaces:interfaces/interface/name`. Choice,
   * case, input and output nodes don't appear in data paths and are looked
   * through; list keys and predicates are not allowed.
   */
  find(path: string): SchemaNode | undefined {
    const steps = path.replace(/^\//, '').split('/');
    let candidates: readonly SchemaNode[] = [...this.dataNodes, ...this.rpcs, ...this.notifications].flatMap((n) => (TRANSPARENT.has(n.kind) ? dataChildren(n) : [n]));
    let module: string | undefined;
    let found: SchemaNode | undefined;
    for (const step of steps) {
      const colon = step.indexOf(':');
      if (colon !== -1) module = step.slice(0, colon);
      const name = colon === -1 ? step : step.slice(colon + 1);
      if (module === undefined) return undefined;
      found = candidates.find((c) => c.name === name && c.module.name === module);
      if (found === undefined) return undefined;
      candidates = dataChildren(found);
    }
    return found;
  }

  /**
   * The children of the node at `path` (`/` for the top level), as they
   * appear in data: choice and case looked through. Undefined when the path
   * names no node.
   *
   * Paths are read tolerantly, for interactive use: a step may name its
   * module by module name or YANG prefix, or not at all when the name is
   * unambiguous, and list predicates are skipped:
   * `/if:interfaces/interface[name='eth0']` and `/interfaces/interface` both
   * work.
   */
  children(path = '/', options: QueryOptions = {}): NodeInfo[] | undefined {
    options = this.#defaults(options);
    const query = this.#query();
    const node = query.resolve(path, options);
    if (node === null) return undefined;
    return query.candidates(node, options).map((n) => query.info(n));
  }

  /** What the node at `path` is: kind, type, keys, defaults, description. Paths are read as by {@link children}. */
  describe(path: string, options: QueryOptions = {}): NodeInfo | undefined {
    options = this.#defaults(options);
    const query = this.#query();
    const node = query.resolve(path, options);
    return node === null || node === undefined ? undefined : query.info(node);
  }

  /**
   * Completions of a partly typed data path, for tab completion: node names
   * at the step being typed, list key names after `[`, and key values after
   * `=` when the key's type is a closed set (enumeration, identityref,
   * boolean). Earlier steps are read as by {@link children}.
   */
  complete(partial: string, options: QueryOptions = {}): PathCompletion[] {
    return this.#query().complete(partial, this.#defaults(options));
  }

  /** Queries of a configuration datastore's schema leave out state data unless asked. */
  #defaults(options: QueryOptions): QueryOptions {
    return this.holdsState || options.config !== undefined ? options : { ...options, config: true };
  }

  #queryCache: SchemaQuery | undefined;
  #query(): SchemaQuery {
    return (this.#queryCache ??= new SchemaQuery(this));
  }
}

/** A node's children as they appear in data: choice, case, input and output looked through. */
export function dataChildren(node: SchemaNode): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const c of node.children) {
    if (TRANSPARENT.has(c.kind)) out.push(...dataChildren(c));
    else out.push(c);
  }
  return out;
}
