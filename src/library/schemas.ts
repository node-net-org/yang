/**
 * Schemas from a server's YANG library: one per library schema, each
 * compiled once and shared by every datastore that uses it, with a view per
 * datastore (RFC 8342).
 */

import { compileSchema } from '../compile/compile.js';
import type { ModuleRequest } from '../compile/loader.js';
import type { Diagnostic } from '../location.js';
import type { Schema } from '../schema/schema.js';
import type { ModuleSource } from '../source/source.js';
import type { LibraryModule, ModuleRef, YangLibrary } from './library.js';

export interface LibraryCompileOptions {
  /** Where module text comes from: files, memory, or `<get-schema>` in a protocol package. */
  readonly source: ModuleSource;
  /**
   * Compile only these implemented modules, plus the modules that deviate
   * or augment them (by the library's deviation and RFC 10035 augmented-by
   * lists), instead of every module. Without augmented-by lists, augments
   * from modules outside the subset are missing, and a warning says so.
   */
  readonly only?: readonly string[];
  /** Keep the parsed statements in the compiled schemas: see `CompileOptions.keepStatements`. Default false. */
  readonly keepStatements?: boolean;
}

const LIBRARY_SOURCE = { line: 1, column: 1, offset: 0, source: 'yang-library' };

/** One schema per library schema, and a view of it per datastore. */
export class ServerSchemas {
  /** The library the schemas were built from. */
  readonly library: YangLibrary;
  /** Compiled schemas by library schema name. Library schemas with the same modules share one. */
  readonly schemas: ReadonlyMap<string, Schema>;
  /** A view of its schema per datastore the library lists, by qualified datastore name. */
  readonly datastores: ReadonlyMap<string, Schema>;
  /** Problems with the library itself; compile problems are in each schema's diagnostics. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(library: YangLibrary, schemas: ReadonlyMap<string, Schema>, diagnostics: readonly Diagnostic[]) {
    this.library = library;
    this.schemas = schemas;
    this.diagnostics = diagnostics;
    const datastores = new Map<string, Schema>();
    for (const d of library.datastores) {
      const schema = schemas.get(d.schema);
      if (schema !== undefined) datastores.set(d.name, schema.forDatastore(d.name));
    }
    this.datastores = datastores;
  }

  /**
   * The schema of a datastore: `running`, `operational`, or a datastore
   * identity as `module:name`. For a library without datastores (RFC 7895
   * or a hello, from servers without NMDA), the one schema serves every
   * datastore. Undefined when the library doesn't list the datastore.
   */
  datastore(name: string): Schema | undefined {
    const qualified = name.includes(':') ? name : `ietf-datastores:${name}`;
    if (this.library.datastores.length > 0) return this.datastores.get(qualified);
    const only = [...this.schemas.values()][0];
    return only?.forDatastore(qualified);
  }
}

/**
 * Compiles the schemas a server's YANG library describes. Exact revisions,
 * features and deviations come from the library; module text from the
 * source.
 *
 * Problems are reported in diagnostics, never thrown.
 */
export async function compileYangLibrary(library: YangLibrary, options: LibraryCompileOptions): Promise<ServerSchemas> {
  const diagnostics: Diagnostic[] = [];
  const warn = (code: string, message: string): void => {
    diagnostics.push({ severity: 'warning', code, message, location: LIBRARY_SOURCE });
  };
  const sets = new Map(library.moduleSets.map((s) => [s.name, s]));
  const compiled = new Map<string, Promise<Schema>>();
  const schemas = new Map<string, Schema>();

  for (const schema of library.schemas) {
    const modules = new Map<string, LibraryModule>();
    const importOnly = new Map<string, ModuleRef>();
    for (const setName of schema.moduleSets) {
      const set = sets.get(setName);
      if (set === undefined) {
        warn('unknown-module-set', `schema ${schema.name} names module set ${setName}, which the library doesn't have`);
        continue;
      }
      for (const m of set.modules) {
        const prior = modules.get(m.name);
        if (prior !== undefined && prior.revision !== m.revision) {
          warn('conflicting-revisions', `schema ${schema.name} implements ${m.name} in revisions ${prior.revision ?? '(none)'} and ${m.revision ?? '(none)'}`);
          continue;
        }
        modules.set(m.name, m);
      }
      for (const m of set.importOnly) importOnly.set(`${m.name}@${m.revision ?? ''}`, m);
    }
    for (const m of modules.values()) {
      for (const d of m.deviations) {
        if (!modules.has(d.name)) warn('unknown-deviation', `${m.name} is deviated by ${d.name}, which schema ${schema.name} doesn't implement`);
      }
    }

    let implement = [...modules.values()];
    if (options.only !== undefined) implement = subset(implement, options.only, schema.name, warn);
    const request = (m: ModuleRef): ModuleRequest => (m.revision === undefined ? { name: m.name } : { name: m.name, revision: m.revision });
    // Every implemented module's features, also those outside a subset: a module the subset loads only
    // as an import (a grouping's module, say) still has the features the server says it supports.
    const features = Object.fromEntries([...modules.values()].map((m) => [m.name, m.features]));
    const submodules = [...implement, ...importOnly.values()].flatMap((m) => ('submodules' in m ? (m.submodules as readonly ModuleRef[]) : []));
    const key = JSON.stringify([implement.map((m) => [m.name, m.revision]).sort(), Object.entries(features).map(([n, f]) => [n, [...f].sort()]).sort(), [...importOnly.keys()].sort()]);
    let promise = compiled.get(key);
    if (promise === undefined) {
      promise = compileSchema({
        source: options.source,
        modules: implement.map(request),
        importOnly: [...importOnly.values()].filter((m) => !implement.some((i) => i.name === m.name && i.revision === m.revision)).map(request),
        submodules: submodules.map(request),
        features,
        importOnlyFeatures: false,
        ...(options.keepStatements === undefined ? {} : { keepStatements: options.keepStatements }),
      });
      compiled.set(key, promise);
    }
    schemas.set(schema.name, await promise);
  }
  for (const d of library.datastores) {
    if (!schemas.has(d.schema)) warn('unknown-schema', `datastore ${d.name} uses schema ${d.schema}, which the library doesn't have`);
  }
  return new ServerSchemas(library, schemas, diagnostics);
}

/** The modules named, and every module that deviates or augments one of them, transitively. */
function subset(all: readonly LibraryModule[], only: readonly string[], schema: string, warn: (code: string, message: string) => void): LibraryModule[] {
  const byName = new Map(all.map((m) => [m.name, m]));
  const wanted = new Set<string>();
  const queue = [...only];
  let missingAugmentedBy = false;
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (wanted.has(name)) continue;
    const m = byName.get(name);
    if (m === undefined) {
      warn('unknown-module', `${name} is not implemented in schema ${schema}`);
      continue;
    }
    wanted.add(name);
    queue.push(...m.deviations.map((d) => d.name));
    if (m.augmentedBy === undefined) missingAugmentedBy = true;
    else queue.push(...m.augmentedBy);
  }
  if (missingAugmentedBy) warn('no-augmented-by', `the library has no augmented-by lists (RFC 10035), so augments from modules outside the subset may be missing`);
  return all.filter((m) => wanted.has(m.name));
}
