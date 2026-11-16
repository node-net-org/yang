/**
 * Schema → RFC 8525 YANG library data: what a server would report for it.
 * Used for RFC 9195 instance-data headers and to compare with other tools.
 */

import type { JsonValue } from '../data/lexical.js';
import type { CompiledModule } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';

export interface YangLibraryWriteOptions {
  /** The module set's name. Default `complete`. */
  readonly moduleSet?: string;
  /** The schema's name. Default the module set's name. */
  readonly schema?: string;
  /** Datastores that use the schema, as identities (`ietf-datastores:running`, or a bare name). Default none. */
  readonly datastores?: readonly string[];
  /** The content-id. Default a hash of the module set. */
  readonly contentId?: string;
}

type JsonObject = { [k: string]: JsonValue };

/**
 * The RFC 8525 `yang-library` container for a schema, in RFC 7951 JSON:
 * implemented modules with their enabled features, deviations and
 * submodules, and the modules only imported as import-only modules.
 * Modules are sorted by name, then revision.
 */
export function yangLibraryData(schema: Schema, options: YangLibraryWriteOptions = {}): { 'ietf-yang-library:yang-library': JsonObject } {
  const order = (a: CompiledModule, b: CompiledModule): number => (a.name === b.name ? ((a.revision ?? '') < (b.revision ?? '') ? -1 : 1) : a.name < b.name ? -1 : 1);
  const modules = [...schema.allModules].sort(order);
  const withRevision = (m: { name: string; revision: string | undefined }): JsonObject => ({ name: m.name, ...(m.revision === undefined ? {} : { revision: m.revision }) });
  const submodules = (m: CompiledModule): JsonObject => (m.includes.length === 0 ? {} : { submodule: m.includes.map(withRevision) });

  const implemented = modules
    .filter((m) => m.implemented)
    .map((m) => ({
      ...withRevision(m),
      namespace: m.namespace,
      ...submodules(m),
      ...(m.enabledFeatures.size === 0 ? {} : { feature: [...m.enabledFeatures].sort() }),
      ...(m.deviations.length === 0 ? {} : { deviation: [...m.deviations].sort() }),
    }));
  const importOnly = modules.filter((m) => !m.implemented).map((m) => ({ ...withRevision(m), namespace: m.namespace, ...submodules(m) }));

  const setName = options.moduleSet ?? 'complete';
  const set: JsonObject = { name: setName, module: implemented, ...(importOnly.length === 0 ? {} : { 'import-only-module': importOnly }) };
  const contentId = options.contentId ?? contentHash(JSON.stringify(set));
  const schemaName = options.schema ?? setName;
  const datastores = (options.datastores ?? []).map((d) => ({ name: d.includes(':') ? d : `ietf-datastores:${d}`, schema: schemaName }));
  return {
    'ietf-yang-library:yang-library': {
      'module-set': [set],
      schema: [{ name: schemaName, 'module-set': [setName] }],
      ...(datastores.length === 0 ? {} : { datastore: datastores }),
      'content-id': contentId,
    },
  };
}

/**
 * A 64-bit hash of the text as 16 hex digits (two FNV-1a lanes over its
 * UTF-16 code units). The content-id only has to change when the module set
 * does (RFC 8525 §3); it needn't be cryptographic, and computing it needs
 * nothing from Node.js.
 */
function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
