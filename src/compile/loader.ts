/**
 * Loads a module set: the requested modules, everything they import, and
 * every submodule they include, fetched from a {@link ModuleSource}.
 *
 * Loading is in two passes. The first fetches and parses the whole closure
 * (asynchronously, since sources may be remote). The second links it
 * (synchronously): prefix maps, belongs-to checks, import cycles, and a
 * dependency order for the compiler.
 *
 * A module can be loaded in more than one revision (RFC 7950 §5.6.5): one
 * primary revision, which is the implemented one, or else the one asked for
 * first (for requests, the latest), and secondary revisions that some import
 * names with `revision-date`. Secondary revisions are never implemented.
 * Modules are keyed by name for the primary revision and `name@revision` for
 * the others. An import without a revision date gets the primary revision.
 */

import { YangSyntaxError } from '../errors.js';
import type { YangVersion } from '../grammar/statements.js';
import type { Diagnostic, Severity, SourceLocation } from '../location.js';
import { parseModuleText } from '../parse/module.js';
import { substatement, substatements, type Statement } from '../parse/statement.js';
import { latestRevision, type ModuleSource } from '../source/source.js';

/** One file of a module: the module itself or one of its submodules. */
export interface LoadedFile {
  readonly name: string;
  readonly statement: Statement;
  readonly yangVersion: YangVersion;
  readonly isSubmodule: boolean;
  /** Prefix → module name, for every prefix this file can use: its own and its imports'. */
  readonly prefixes: Map<string, string>;
  /** Prefix → module key (see {@link LoadedModule.key}), for the same prefixes. */
  readonly keys: Map<string, string>;
  /** The module this file belongs to. */
  module: LoadedModule;
}

export interface LoadedModule {
  /** The name for the primary revision, `name@revision` for a secondary one. */
  readonly key: string;
  readonly name: string;
  readonly revision: string | undefined;
  readonly statement: Statement;
  readonly yangVersion: YangVersion;
  readonly namespace: string;
  readonly prefix: string;
  /** The module file first, then its submodules. */
  readonly files: LoadedFile[];
  /** Keys of modules imported by any of the module's files. */
  readonly imports: Set<string>;
  implemented: boolean;
}

export interface ModuleRequest {
  readonly name: string;
  readonly revision?: string;
}

export interface LoadRequests {
  /** Modules to implement. */
  readonly implement: readonly ModuleRequest[];
  /** Modules to load without implementing them, such as a YANG library's import-only modules. */
  readonly importOnly?: readonly ModuleRequest[];
  /** Revisions of submodules, for includes without a revision date. */
  readonly submodules?: readonly ModuleRequest[];
}

export interface LoadResult {
  /** By key: name for primary revisions, `name@revision` for the others. */
  readonly modules: Map<string, LoadedModule>;
  /** Modules in dependency order: every module after the modules it imports. */
  readonly order: LoadedModule[];
  readonly diagnostics: Diagnostic[];
}

interface Fetched {
  readonly key: string;
  readonly name: string;
  readonly statement: Statement;
  readonly yangVersion: YangVersion;
  readonly revision: string | undefined;
}

/** Where a module was asked for, for diagnostics. */
interface Want {
  readonly name: string;
  readonly revision: string | undefined;
  readonly submodule: boolean;
  readonly implement: boolean;
  readonly from: Statement | undefined;
}

/** Requests in the order that picks primary revisions: implemented first, then the latest revision. */
function requestOrder(requests: LoadRequests): Want[] {
  const want = (r: ModuleRequest, implement: boolean): Want => ({ name: r.name, revision: r.revision, submodule: false, implement, from: undefined });
  const importOnly = [...(requests.importOnly ?? [])].sort((a, b) => ((a.revision ?? '9999') < (b.revision ?? '9999') ? 1 : -1));
  return [...requests.implement.map((r) => want(r, true)), ...importOnly.map((r) => want(r, false))];
}

export async function loadModules(requests: LoadRequests, source: ModuleSource): Promise<LoadResult> {
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Severity, code: string, message: string, location: SourceLocation | undefined): void => {
    diagnostics.push({ severity, code, message, location: location ?? { line: 1, column: 1, offset: 0 } });
  };
  const submoduleRevisions = new Map((requests.submodules ?? []).flatMap((r) => (r.revision === undefined ? [] : [[r.name, r.revision] as const])));

  // Pass 1: fetch and parse the closure.
  const fetched = new Map<string, Fetched | null>();
  /** Keys of each name, primary first, with the revision asked for while in flight. */
  const keysOf = new Map<string, { key: string; asked: string | undefined }[]>();
  /** The key each import and include statement resolved to. */
  const resolved = new Map<Statement, string>();
  const implementedKeys = new Set<string>();
  const revisionOfKey = (k: { key: string; asked: string | undefined }): string | undefined => {
    const f = fetched.get(k.key);
    return f === undefined ? k.asked : (f?.revision ?? undefined);
  };

  const queue: Want[] = requestOrder(requests);
  const enqueueDependencies = (statement: Statement): void => {
    for (const imp of substatements(statement, 'import')) {
      if (imp.argument !== undefined) {
        queue.push({ name: imp.argument, revision: substatement(imp, 'revision-date')?.argument, submodule: false, implement: false, from: imp });
      }
    }
    for (const inc of substatements(statement, 'include')) {
      if (inc.argument !== undefined) {
        const revision = substatement(inc, 'revision-date')?.argument ?? submoduleRevisions.get(inc.argument);
        queue.push({ name: inc.argument, revision, submodule: true, implement: false, from: inc });
      }
    }
  };

  while (queue.length > 0) {
    const batch: { want: Want; key: string }[] = [];
    const deferred: Want[] = [];
    for (const w of queue.splice(0)) {
      const keys = keysOf.get(w.name);
      if (keys === undefined) {
        // The first want of a name makes the primary key.
        keysOf.set(w.name, [{ key: w.name, asked: w.revision }]);
        batch.push({ want: w, key: w.name });
        if (w.from !== undefined) resolved.set(w.from, w.name);
        if (w.implement) implementedKeys.add(w.name);
        continue;
      }
      // A key in this batch whose revision isn't known yet: decide after it loads.
      if (keys.some((k) => !fetched.has(k.key) && k.asked === undefined) && w.revision !== undefined) {
        deferred.push(w);
        continue;
      }
      const primary = keys[0]!;
      const match = w.revision === undefined ? primary : keys.find((k) => revisionOfKey(k) === w.revision);
      if (match !== undefined) {
        if (w.from !== undefined) resolved.set(w.from, match.key);
        if (w.implement) {
          if (match === primary) implementedKeys.add(match.key);
          else report('error', 'multiple-implemented-revisions', `more than one revision of ${w.name} is to be implemented`, w.from?.location);
        }
        continue;
      }
      if (w.implement) {
        report('error', 'multiple-implemented-revisions', `${w.name}@${w.revision ?? ''} is to be implemented, but revision ${revisionOfKey(primary) ?? '(none)'} is already loaded`, w.from?.location);
        continue;
      }
      const key = `${w.name}@${w.revision!}`;
      keys.push({ key, asked: w.revision });
      batch.push({ want: w, key });
      if (w.from !== undefined) resolved.set(w.from, key);
    }
    // Deferred wants wait for a key in this batch, so the batch is never empty when there are any.
    queue.push(...deferred);
    if (batch.length === 0) break;

    // Fetch the batch in parallel.
    const results = await Promise.all(batch.map(async (b) => ({ ...b, text: await source.load(b.want.name, b.want.revision) })));
    for (const { want, key, text } of results) {
      const primaryKey = keysOf.get(want.name)![0]!.key;
      if (text === undefined) {
        if (key !== primaryKey && fetched.get(primaryKey) !== null) {
          // A revision the source doesn't have: fall back on the one loaded.
          keysOf.set(want.name, keysOf.get(want.name)!.filter((k) => k.key !== key));
          if (want.from !== undefined) resolved.set(want.from, primaryKey);
          const have = fetched.get(primaryKey);
          report('warning', 'revision-mismatch', `${want.name} revision ${want.revision ?? ''} was asked for, but revision ${have?.revision ?? '(none)'} is loaded`, want.from?.location);
          continue;
        }
        fetched.set(key, null);
        const what = want.submodule ? 'submodule' : 'module';
        report('error', 'module-not-found', `${what} ${want.name}${want.revision === undefined ? '' : `@${want.revision}`} was not found`, want.from?.location);
        continue;
      }
      let parsed;
      try {
        parsed = parseModuleText(text);
      } catch (err) {
        if (!(err instanceof YangSyntaxError)) throw err;
        fetched.set(key, null);
        report('error', 'syntax-error', err.message.replace(/^\S+: /, ''), err.location);
        continue;
      }
      diagnostics.push(...parsed.diagnostics);
      const statement = parsed.statement;
      const revision = latestRevision(substatements(statement, 'revision').map((r) => r.argument ?? ''));
      if (statement.argument !== want.name) {
        report('error', 'wrong-module-name', `asked for ${want.name}, but the text holds ${statement.keyword} ${statement.argument ?? ''}`, statement.location);
      }
      if ((statement.keyword === 'submodule') !== want.submodule) {
        report('error', 'wrong-module-kind', `${want.name} is a ${statement.keyword}, but was ${want.submodule ? 'included' : 'imported or requested'} as a ${want.submodule ? 'submodule' : 'module'}`, want.from?.location ?? statement.location);
      }
      if (want.revision !== undefined && revision !== want.revision) {
        report('warning', 'revision-mismatch', `${want.name} revision ${want.revision} was asked for, but the text's latest revision is ${revision ?? '(none)'}`, want.from?.location ?? statement.location);
      }
      fetched.set(key, { key, name: want.name, statement, yangVersion: parsed.yangVersion, revision });
      enqueueDependencies(statement);
    }
  }

  // Pass 2: link.
  const modules = new Map<string, LoadedModule>();
  for (const f of fetched.values()) {
    if (f === null || f.statement.keyword !== 'module') continue;
    const prefix = substatement(f.statement, 'prefix')?.argument ?? f.name;
    const module: LoadedModule = {
      key: f.key,
      name: f.name,
      revision: f.revision,
      statement: f.statement,
      yangVersion: f.yangVersion,
      namespace: substatement(f.statement, 'namespace')?.argument ?? '',
      prefix,
      files: [],
      imports: new Set(),
      implemented: implementedKeys.has(f.key),
    };
    module.files.push(linkFile(f, module, prefix, resolved, report));
    modules.set(f.key, module);
  }

  // Attach submodules (including those included by submodules) to their modules.
  for (const module of modules.values()) {
    const seen = new Set<string>();
    const including = (f: Fetched) => substatements(f.statement, 'include').map((inc) => ({ inc, from: f }));
    const pending = including(module);
    while (pending.length > 0) {
      const { inc, from } = pending.shift()!;
      const key = resolved.get(inc);
      if (key === undefined) continue;
      const sub = fetched.get(key);
      if (sub === null || sub === undefined || sub.statement.keyword !== 'submodule') continue;
      if (sub.yangVersion !== from.yangVersion) {
        // RFC 7950 §12. pyang refuses it; libyang accepts it, so it stays a warning.
        report('warning', 'include-version-mismatch', `${from.statement.keyword} ${from.name} is YANG version ${from.yangVersion}, but includes submodule ${sub.name}, which is version ${sub.yangVersion} (RFC 7950 §12)`, inc.location);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const belongsTo = substatement(sub.statement, 'belongs-to');
      if (belongsTo?.argument !== module.name) {
        report('error', 'wrong-belongs-to', `submodule ${sub.name} belongs to ${belongsTo?.argument ?? '(nothing)'}, not ${module.name}`, belongsTo?.location ?? sub.statement.location);
        continue;
      }
      const ownPrefix = substatement(belongsTo, 'prefix')?.argument ?? module.prefix;
      module.files.push(linkFile(sub, module, ownPrefix, resolved, report));
      pending.push(...including(sub));
    }
    for (const file of module.files) {
      for (const imp of substatements(file.statement, 'import')) {
        const key = resolved.get(imp);
        if (key !== undefined && imp.argument !== module.name) module.imports.add(key);
      }
    }
  }

  const roots = requests.implement.map((r) => modules.get(r.name)).filter((m): m is LoadedModule => m !== undefined);
  return { modules, order: dependencyOrder(modules, roots, report), diagnostics };
}

function linkFile(
  f: Fetched,
  module: LoadedModule,
  ownPrefix: string,
  resolved: ReadonlyMap<Statement, string>,
  report: (severity: Severity, code: string, message: string, location: SourceLocation | undefined) => void,
): LoadedFile {
  const prefixes = new Map<string, string>([[ownPrefix, module.name]]);
  const keys = new Map<string, string>([[ownPrefix, module.key]]);
  for (const imp of substatements(f.statement, 'import')) {
    const prefix = substatement(imp, 'prefix')?.argument;
    if (prefix === undefined || imp.argument === undefined) continue;
    if (prefixes.has(prefix)) {
      report('error', 'duplicate-prefix', `prefix '${prefix}' is already used in ${f.name}`, imp.location);
      continue;
    }
    if (imp.argument === module.name) {
      report('error', 'self-import', `${f.name} imports its own module`, imp.location);
      continue;
    }
    prefixes.set(prefix, imp.argument);
    keys.set(prefix, resolved.get(imp) ?? imp.argument);
  }
  return { name: f.name, statement: f.statement, yangVersion: f.yangVersion, isSubmodule: f.statement.keyword === 'submodule', prefixes, keys, module };
}

/**
 * Orders modules so each comes after the modules it imports, reporting
 * import cycles (RFC 7950 §7.1.5). Depth first from the requested modules in
 * the order requested, then the rest by name; imports in the order written.
 * That is the order pyang validates modules in, so augments from different
 * modules add their nodes to a target in the same order as pyang's.
 */
function dependencyOrder(
  modules: Map<string, LoadedModule>,
  roots: readonly LoadedModule[],
  report: (severity: Severity, code: string, message: string, location: SourceLocation | undefined) => void,
): LoadedModule[] {
  const order: LoadedModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: LoadedModule, stack: string[]): void => {
    const s = state.get(m.key);
    if (s === 'done') return;
    if (s === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(m.key)), m.key];
      report('error', 'import-cycle', `circular imports: ${cycle.join(' → ')}`, m.statement.location);
      return;
    }
    state.set(m.key, 'visiting');
    for (const key of m.imports) {
      const dep = modules.get(key);
      if (dep !== undefined) visit(dep, [...stack, m.key]);
    }
    state.set(m.key, 'done');
    order.push(m);
  };
  for (const m of roots) visit(m, []);
  for (const m of [...modules.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) visit(m, []);
  return order;
}
