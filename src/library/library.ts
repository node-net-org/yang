/**
 * What a server says it implements: RFC 8525 YANG library data (with RFC
 * 10035's augmented-by list), RFC 7895 `modules-state`, or the module
 * capabilities of a YANG 1.0 `<hello>` (RFC 7950 §5.6.4), read into one
 * protocol-neutral description.
 *
 * Reading works on the RFC 7951 JSON form of the data, or on a decoded
 * {@link DataTree}. {@link decodeYangLibrary} reads XML or JSON text before
 * any schema exists, with the bundled ietf-yang-library module.
 */

import { YangDataError } from '../errors.js';
import { DataTree } from '../data/tree.js';
import { encodeJson } from '../json/encode.js';
import { decodeJson } from '../json/decode.js';
import { decodeXml } from '../xml/decode.js';
import type { XmlElementLike } from '../xml/element.js';
import { compileSchema } from '../compile/compile.js';
import type { Schema } from '../schema/schema.js';
import { builtinSource } from '../source/source.js';

/** A module or submodule named by revision. */
export interface ModuleRef {
  readonly name: string;
  /** Absent when the module has no revision statement (or the server didn't say). */
  readonly revision?: string;
}

/** An implemented module in a module set. */
export interface LibraryModule extends ModuleRef {
  readonly namespace?: string;
  /** Enabled features. */
  readonly features: readonly string[];
  /** Modules whose deviations apply to this one. */
  readonly deviations: readonly ModuleRef[];
  readonly submodules: readonly ModuleRef[];
  /** Modules that augment this one (RFC 10035). Undefined when the server didn't give the list. */
  readonly augmentedBy?: readonly string[];
  /** URLs the server says the module can be fetched from. */
  readonly locations: readonly string[];
}

/** A module that is imported but not implemented. */
export interface ImportOnlyModule extends ModuleRef {
  readonly namespace?: string;
  readonly submodules: readonly ModuleRef[];
  readonly locations: readonly string[];
}

export interface ModuleSetInfo {
  readonly name: string;
  readonly modules: readonly LibraryModule[];
  readonly importOnly: readonly ImportOnlyModule[];
}

/** A schema: the union of some module sets (RFC 8525 §3). */
export interface LibrarySchema {
  readonly name: string;
  readonly moduleSets: readonly string[];
}

export interface LibraryDatastore {
  /** The datastore identity, qualified by module name: `ietf-datastores:running`. */
  readonly name: string;
  /** The name of its schema. */
  readonly schema: string;
}

/**
 * A server's modules: module sets, the schemas made of them, and which
 * datastore uses which schema.
 */
export interface YangLibrary {
  /** Where the description came from. */
  readonly format: 'yang-library' | 'modules-state' | 'hello';
  readonly moduleSets: readonly ModuleSetInfo[];
  readonly schemas: readonly LibrarySchema[];
  /**
   * The datastores and their schemas. Empty for `modules-state` and hello
   * descriptions, which come from servers without NMDA: there, one schema
   * applies to every datastore.
   */
  readonly datastores: readonly LibraryDatastore[];
  /** `content-id` (RFC 8525) or `module-set-id` (RFC 7895). */
  readonly contentId?: string;
}

const YL = 'ietf-yang-library';
const AUG = 'ietf-yang-library-augmentedby';

type Json = { readonly [k: string]: unknown };

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function array(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
/** A member by its simple or module-qualified name. */
function member(o: Json, module: string, name: string): unknown {
  return o[name] ?? o[`${module}:${name}`];
}
function ref(name: string, revision: string | undefined): ModuleRef {
  return revision === undefined ? { name } : { name, revision };
}

/**
 * Reads YANG library data: RFC 8525 `yang-library`, or RFC 7895
 * `modules-state` when that is all there is. The input is a decoded tree, or
 * the RFC 7951 JSON form (an object, or its text) of a document holding
 * either container, as a `<get>` of `/yang-library` gives.
 *
 * @throws YangDataError when the input holds neither container
 */
export function readYangLibrary(input: DataTree | string | object): YangLibrary {
  const json: unknown = input instanceof DataTree ? encodeJson(input) : typeof input === 'string' ? JSON.parse(input) : input;
  if (!isObject(json)) throw new YangDataError([{ code: 'unexpected-content', message: 'YANG library data must be an object', path: '/', severity: 'error' }]);
  const library = json[`${YL}:yang-library`];
  if (isObject(library)) return fromYangLibrary(library);
  const state = json[`${YL}:modules-state`];
  if (isObject(state)) return fromModulesState(state);
  throw new YangDataError([{ code: 'missing-node', message: `the data has neither ${YL}:yang-library nor ${YL}:modules-state`, path: '/', severity: 'error' }]);
}

function fromYangLibrary(lib: Json): YangLibrary {
  const submodules = (m: Json): ModuleRef[] => array(m['submodule']).map((s) => ref(String(s['name']), str(s['revision'])));
  const moduleSets: ModuleSetInfo[] = array(lib['module-set']).map((set) => {
    const modules = array(set['module']);
    const revisionOf = new Map(modules.map((m) => [String(m['name']), str(m['revision'])]));
    return {
      name: String(set['name']),
      modules: modules.map((m): LibraryModule => {
        const augmentedBy = member(m, AUG, 'augmented-by');
        const out: LibraryModule = {
          ...ref(String(m['name']), str(m['revision'])),
          ...(str(m['namespace']) === undefined ? {} : { namespace: String(m['namespace']) }),
          features: strings(m['feature']),
          deviations: strings(m['deviation']).map((d) => ref(d, revisionOf.get(d))),
          submodules: submodules(m),
          locations: strings(m['location']),
          ...(augmentedBy === undefined ? {} : { augmentedBy: strings(augmentedBy) }),
        };
        return out;
      }),
      importOnly: array(set['import-only-module']).map((m) => ({
        ...ref(String(m['name']), str(m['revision'])),
        ...(str(m['namespace']) === undefined ? {} : { namespace: String(m['namespace']) }),
        submodules: submodules(m),
        locations: strings(m['location']),
      })),
    };
  });
  const contentId = str(lib['content-id']);
  return {
    format: 'yang-library',
    moduleSets,
    schemas: array(lib['schema']).map((s) => ({ name: String(s['name']), moduleSets: strings(s['module-set']) })),
    datastores: array(lib['datastore']).map((d) => ({ name: qualifyDatastore(String(d['name'])), schema: String(d['schema']) })),
    ...(contentId === undefined ? {} : { contentId }),
  };
}

function qualifyDatastore(name: string): string {
  return name.includes(':') ? name : `ietf-datastores:${name}`;
}

/** The single module set and schema made from `modules-state` or a hello. */
const LEGACY = 'legacy';

function fromModulesState(state: Json): YangLibrary {
  const modules: LibraryModule[] = [];
  const importOnly: ImportOnlyModule[] = [];
  for (const m of array(state['module'])) {
    const base = {
      ...ref(String(m['name']), str(m['revision'])),
      ...(str(m['namespace']) === undefined ? {} : { namespace: String(m['namespace']) }),
      submodules: array(m['submodule']).map((s) => ref(String(s['name']), str(s['revision']))),
      locations: str(m['schema']) === undefined ? [] : [String(m['schema'])],
    };
    if (m['conformance-type'] === 'import') {
      importOnly.push(base);
      continue;
    }
    const augmentedBy = member(m, AUG, 'augmented-by');
    modules.push({
      ...base,
      features: strings(m['feature']),
      deviations: array(m['deviation']).map((d) => ref(String(d['name']), str(d['revision']))),
      ...(augmentedBy === undefined ? {} : { augmentedBy: strings(augmentedBy) }),
    });
  }
  const contentId = str(state['module-set-id']);
  return {
    format: 'modules-state',
    moduleSets: [{ name: LEGACY, modules, importOnly }],
    schemas: [{ name: LEGACY, moduleSets: [LEGACY] }],
    datastores: [],
    ...(contentId === undefined ? {} : { contentId }),
  };
}

// ---------------------------------------------------------------------------
// Hello capabilities

/** A module capability URI (RFC 7950 §5.6.4, RFC 6020 §5.6.4), parsed. */
export interface ModuleCapability {
  readonly namespace: string;
  readonly name: string;
  readonly revision?: string;
  readonly features: readonly string[];
  /** Names of the modules that deviate this one. */
  readonly deviations: readonly string[];
}

/**
 * Parses one module capability URI from a NETCONF `<hello>`:
 * `namespace?module=name&revision=date&features=a,b&deviations=m`. Returns
 * undefined for a URI that isn't a module capability (no `module`
 * parameter), such as `urn:ietf:params:netconf:base:1.1`.
 */
export function parseModuleCapability(uri: string): ModuleCapability | undefined {
  const text = uri.trim();
  const q = text.indexOf('?');
  if (q === -1) return undefined;
  const params = new Map<string, string>();
  // Parameters are separated by `&`; accept `&amp;` too, from text that was never unescaped.
  for (const part of text.slice(q + 1).split(/&(?:amp;)?/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep it as written
    }
    params.set(part.slice(0, eq), value);
  }
  const name = params.get('module');
  if (name === undefined || name === '') return undefined;
  const list = (v: string | undefined): string[] => (v === undefined || v === '' ? [] : v.split(',').map((x) => x.trim()).filter((x) => x !== ''));
  const revision = params.get('revision');
  return {
    namespace: text.slice(0, q),
    name,
    ...(revision === undefined || revision === '' ? {} : { revision }),
    features: list(params.get('features')),
    deviations: list(params.get('deviations')),
  };
}

/** The YANG library capability of a hello: YANG 1.1 modules aren't listed, the library must be read instead. */
export interface LibraryCapability {
  /** `1.0` (RFC 7950 §5.6.4) or `1.1` (RFC 8526 §2). */
  readonly version: string;
  readonly revision?: string;
  /** `module-set-id` (1.0) or `content-id` (1.1). */
  readonly contentId?: string;
}

/**
 * Builds a module list from the capabilities of a NETCONF `<hello>`, as
 * parsed by the protocol layer. Every advertised module is implemented,
 * with exactly the features advertised; modules named as deviations are
 * added when they aren't advertised themselves.
 *
 * YANG 1.1 modules aren't advertised in a hello. When the server announces
 * the YANG library capability, `library` says so, and the module list
 * should be read from the library instead.
 */
export function fromCapabilities(capabilities: Iterable<string>): YangLibrary & { readonly library?: LibraryCapability } {
  const modules = new Map<string, LibraryModule>();
  const deviationModules = new Set<string>();
  const deviates = new Map<string, string[]>();
  let library: LibraryCapability | undefined;
  for (const uri of capabilities) {
    const lib = /^urn:ietf:params:netconf:capability:yang-library:(1\.[01])(?:\?(.*))?$/.exec(uri.trim());
    if (lib !== null) {
      const params = new URLSearchParams((lib[2] ?? '').replace(/&amp;/g, '&'));
      const revision = params.get('revision') ?? undefined;
      const id = params.get('content-id') ?? params.get('module-set-id') ?? undefined;
      library = { version: lib[1]!, ...(revision === undefined ? {} : { revision }), ...(id === undefined ? {} : { contentId: id }) };
      continue;
    }
    const cap = parseModuleCapability(uri);
    if (cap === undefined) continue;
    modules.set(cap.name, {
      ...ref(cap.name, cap.revision),
      namespace: cap.namespace,
      features: cap.features,
      deviations: [],
      submodules: [],
      locations: [],
    });
    for (const d of cap.deviations) {
      deviationModules.add(d);
      deviates.set(cap.name, [...(deviates.get(cap.name) ?? []), d]);
    }
  }
  for (const d of deviationModules) {
    if (!modules.has(d)) modules.set(d, { name: d, features: [], deviations: [], submodules: [], locations: [] });
  }
  const list = [...modules.values()].map((m) => {
    const devs = deviates.get(m.name);
    return devs === undefined ? m : { ...m, deviations: devs.map((d) => ref(d, modules.get(d)?.revision)) };
  });
  return {
    format: 'hello',
    moduleSets: [{ name: LEGACY, modules: list, importOnly: [] }],
    schemas: [{ name: LEGACY, moduleSets: [LEGACY] }],
    datastores: [],
    ...(library === undefined ? {} : { library }),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap

let librarySchema: Promise<Schema> | undefined;

/**
 * The schema for reading YANG library data itself: the bundled
 * ietf-yang-library (whose 2019 revision also has the deprecated
 * `modules-state`) with RFC 10035's augmented-by list.
 */
export function yangLibrarySchema(): Promise<Schema> {
  librarySchema ??= compileSchema({ source: builtinSource, modules: [YL, AUG] });
  return librarySchema;
}

/**
 * Reads YANG library data from XML or JSON text, or parsed XML elements,
 * before any schema exists: what a client has after a `<get>` of
 * `/yang-library` (or `/modules-state`). Nodes from other modules (vendor
 * augments) are skipped.
 *
 * @throws YangDataError when the data doesn't match ietf-yang-library
 */
export async function decodeYangLibrary(input: string | XmlElementLike | readonly XmlElementLike[]): Promise<YangLibrary> {
  const schema = await yangLibrarySchema();
  const isJson = typeof input === 'string' && /^\s*\{/.test(input);
  const tree = isJson ? decodeJson(schema, input, { unknown: 'skip' }) : decodeXml(schema, input, { unknown: 'skip' });
  return readYangLibrary(tree);
}

