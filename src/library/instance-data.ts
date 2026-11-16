/**
 * YANG instance-data files (RFC 9195): a header describing the data set
 * (name, content schema, revisions, timestamp, datastore) and the data
 * itself, in XML or JSON. The header is the `instance-data-set` structure of
 * ietf-yang-instance-data, bundled with @node-net/yang; the content is ordinary
 * YANG data, read with the codecs once its schema is known.
 */

import { compileSchema } from '../compile/compile.js';
import { NetYangError, YangDataError } from '../errors.js';
import { addDefaults, applyWithDefaults, type WithDefaultsMode } from '../data/defaults.js';
import type { DecodeOptions } from '../data/build.js';
import { AnyInstance, DataTree, type InstanceNode } from '../data/tree.js';
import type { JsonValue } from '../data/lexical.js';
import { decodeJson } from '../json/decode.js';
import { encodeJson } from '../json/encode.js';
import type { Schema } from '../schema/schema.js';
import { builtinSource, type ModuleSource } from '../source/source.js';
import { decodeXml } from '../xml/decode.js';
import { encodeXml } from '../xml/encode.js';
import { isElement, type XmlElementLike } from '../xml/element.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import { readYangLibrary, yangLibrarySchema, type ModuleRef, type YangLibrary } from './library.js';
import { compileYangLibrary } from './schemas.js';
import { yangLibraryData } from './write.js';

const MODULE = 'ietf-yang-instance-data';
const NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-instance-data';
const STRUCTURE = `${MODULE}:instance-data-set`;

/** How the header names the schema of the content (RFC 9195 §2.1). */
export type ContentSchema =
  /** `simplified-inline`: modules, all features enabled, no deviations. */
  | { readonly kind: 'modules'; readonly modules: readonly ModuleRef[] }
  /** `inline`: YANG library data (RFC 8525 or RFC 7895). */
  | { readonly kind: 'inline'; readonly library: YangLibrary }
  /** `uri`: the same schema as another file. */
  | { readonly kind: 'uri'; readonly uri: string };

/** The header of an instance-data file: everything but the content. */
export interface InstanceDataHeader {
  readonly name?: string;
  readonly formatVersion?: string;
  /** How defaults appear in the content (RFC 8040 §4.8.9 modes). The module's default is `report-all`. */
  readonly includesDefaults?: WithDefaultsMode;
  readonly contentSchema?: ContentSchema;
  readonly description?: readonly string[];
  readonly contact?: string;
  readonly organization?: string;
  /** The datastore the data belongs to, as an identity: `ietf-datastores:running`. */
  readonly datastore?: string;
  /** Newest first, as RFC 9195 asks. */
  readonly revisions?: readonly { readonly date: string; readonly description?: string }[];
  /** `yang:date-and-time`. */
  readonly timestamp?: string;
}

type RawContent = { readonly format: 'xml'; readonly elements: readonly XmlElementLike[]; readonly scope: ReadonlyMap<string, string> } | { readonly format: 'json'; readonly value: JsonValue };

let headerSchema: Promise<Schema> | undefined;

/** The schema of the header: ietf-yang-instance-data from the bundled modules. */
export function instanceDataSchema(): Promise<Schema> {
  headerSchema ??= compileSchema({ source: builtinSource, modules: [MODULE, 'ietf-yang-library', 'ietf-yang-library-augmentedby'] });
  return headerSchema;
}

/** An instance-data file as read: its header, and its content ready to decode once the schema is known. */
export class InstanceDataFile {
  readonly header: InstanceDataHeader;
  readonly format: 'xml' | 'json';
  readonly #content: RawContent | undefined;

  constructor(header: InstanceDataHeader, format: 'xml' | 'json', content: RawContent | undefined) {
    this.header = header;
    this.format = format;
    this.#content = content;
  }

  /**
   * Compiles the schema the header names, from a module source: the
   * modules of a `simplified-inline` content schema with every feature, or
   * an `inline` YANG library exactly. For the header's datastore, when it
   * names one.
   *
   * @throws NetYangError when the header gives no content schema or only a
   *   URI: compile the schema yourself and pass it to {@link decode}
   */
  async compileSchema(source: ModuleSource): Promise<Schema> {
    const cs = this.header.contentSchema;
    if (cs === undefined || cs.kind === 'uri') {
      throw new NetYangError(cs === undefined ? 'the instance data names no content schema' : `the content schema is that of another file (${cs.uri}); compile it and decode with it`);
    }
    let schema: Schema;
    if (cs.kind === 'modules') {
      schema = await compileSchema({ source, modules: cs.modules.map((m) => (m.revision === undefined ? { name: m.name } : { name: m.name, revision: m.revision })) });
    } else {
      const schemas = await compileYangLibrary(cs.library, { source });
      const ds = this.header.datastore;
      const forDatastore = ds === undefined ? undefined : schemas.datastore(ds);
      schema = forDatastore ?? [...schemas.schemas.values()][0]!;
    }
    return this.header.datastore === undefined || schema.datastore !== undefined ? schema : schema.forDatastore(this.header.datastore);
  }

  /**
   * Decodes the content. A schema not tied to a datastore is viewed for
   * the header's datastore, when it names one. With `validate`, the content
   * is validated as partial data (RFC 9195 §2): missing mandatory nodes,
   * too few elements and leafrefs whose targets aren't there aren't
   * reported, unless the options say `partial: false`.
   *
   * @throws YangDataError listing every problem in the content
   */
  decode(schema: Schema, options: Omit<DecodeOptions, 'type' | 'operation' | 'structure'> = {}): DataTree {
    if (options.validate !== undefined && options.validate !== false) options = { ...options, validate: { partial: true, ...(options.validate === true ? {} : options.validate) } };
    const s = this.header.datastore !== undefined && schema.datastore === undefined ? schema.forDatastore(this.header.datastore) : schema;
    const content = this.#content;
    if (content === undefined) return new DataTree(s);
    return content.format === 'xml' ? decodeXml(s, content.elements, { ...options, scope: content.scope }) : decodeJson(s, content.value, options);
  }
}

/**
 * Reads an instance-data file (RFC 9195): XML or JSON text, or a value
 * from JSON.parse. The header is checked against ietf-yang-instance-data;
 * the content is decoded later, with {@link InstanceDataFile.decode}.
 *
 * @throws YangDataError when the text is malformed or the header doesn't match
 */
export async function readInstanceData(input: string | object): Promise<InstanceDataFile> {
  const schema = await instanceDataSchema();
  const isXml = typeof input === 'string' && /^\s*</.test(input.replace(/^\uFEFF/, ''));
  if (isXml) return readXml(schema, input);
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      throw new YangDataError([{ code: 'json-syntax', message: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`, path: '/', severity: 'error' }]);
    }
  }
  const set = (value as Record<string, unknown> | null)?.[STRUCTURE];
  if (typeof set !== 'object' || set === null || Array.isArray(set)) {
    throw new YangDataError([{ code: 'missing-node', message: `an instance-data file holds ${STRUCTURE}`, path: '/', severity: 'error' }]);
  }
  const { 'content-data': content, ...rest } = set as Record<string, JsonValue>;
  const tree = decodeJson(schema, { [STRUCTURE]: rest }, { type: 'structure', structure: STRUCTURE });
  const library = (rest['content-schema'] as Record<string, JsonValue> | undefined)?.['inline-yang-library'];
  const header = headerOf(tree, library === undefined ? undefined : readYangLibrary(library as object));
  return new InstanceDataFile(header, 'json', content === undefined ? undefined : { format: 'json', value: content });
}

async function readXml(schema: Schema, text: string): Promise<InstanceDataFile> {
  const roots = parseXml(text);
  const root = roots[0];
  if (roots.length !== 1 || root === undefined || root.name !== 'instance-data-set' || root.ns !== NAMESPACE) {
    throw new YangDataError([{ code: 'missing-node', message: `an instance-data file is one instance-data-set element in namespace ${NAMESPACE}`, path: '/', severity: 'error' }]);
  }
  const child = (el: XmlElementLike, name: string): XmlElementLike | undefined =>
    (el.children ?? []).find((c): c is XmlElementLike => isElement(c) && c.name === name && (c.ns ?? NAMESPACE) === NAMESPACE);
  const scopeOf = (...els: (XmlElementLike | undefined)[]): Map<string, string> => new Map(els.flatMap((e) => [...(e?.declarations ?? [])]));
  const contentData = child(root, 'content-data');
  const contentSchema = child(root, 'content-schema');
  const inline = contentSchema === undefined ? undefined : child(contentSchema, 'inline-yang-library');

  // The header without the content, which may be large and is decoded later with its own schema.
  const header = { ...root, children: (root.children ?? []).filter((c) => c !== contentData) };
  const tree = decodeXml(schema, header, { type: 'structure', structure: STRUCTURE });
  let library: YangLibrary | undefined;
  if (inline !== undefined) {
    const elements = (inline.children ?? []).filter(isElement);
    library = readYangLibrary(decodeXml(await yangLibrarySchema(), elements, { unknown: 'skip', scope: scopeOf(root, contentSchema, inline) }));
  }
  const elements = (contentData?.children ?? []).filter(isElement);
  return new InstanceDataFile(headerOf(tree, library), 'xml', contentData === undefined ? undefined : { format: 'xml', elements, scope: scopeOf(root, contentData) });
}

/** The header fields from the decoded `instance-data-set` structure, with the module's defaults where a field is absent. */
function headerOf(tree: DataTree, library: YangLibrary | undefined): InstanceDataHeader {
  addDefaults(tree);
  const set = tree.children[0];
  if (set === undefined || !('children' in set)) return {};
  // Anydata (inline-yang-library) is read separately; JSON for the rest is the simplest walk.
  const json = encodeJson(set.children.filter((c) => !(c instanceof AnyInstance))) as Record<string, JsonValue>;
  const field = (name: string): JsonValue | undefined => json[`${MODULE}:${name}`] ?? json[name];
  const str = (name: string): string | undefined => (typeof field(name) === 'string' ? (field(name) as string) : undefined);
  const out: { -readonly [K in keyof InstanceDataHeader]: InstanceDataHeader[K] } = {};
  const name = str('name');
  if (name !== undefined) out.name = name;
  const formatVersion = str('format-version');
  if (formatVersion !== undefined) out.formatVersion = formatVersion;
  const includes = str('includes-defaults');
  if (includes !== undefined) out.includesDefaults = includes as WithDefaultsMode;
  const cs = field('content-schema') as Record<string, JsonValue> | undefined;
  if (library !== undefined) out.contentSchema = { kind: 'inline', library };
  else if (Array.isArray(cs?.['module'])) {
    out.contentSchema = {
      kind: 'modules',
      modules: (cs['module'] as string[]).map((m) => {
        const at = m.indexOf('@');
        return at === -1 ? { name: m } : { name: m.slice(0, at), revision: m.slice(at + 1) };
      }),
    };
  } else if (typeof cs?.['same-schema-as-file'] === 'string') out.contentSchema = { kind: 'uri', uri: cs['same-schema-as-file'] };
  const description = field('description');
  if (Array.isArray(description)) out.description = description as string[];
  const contact = str('contact');
  if (contact !== undefined) out.contact = contact;
  const organization = str('organization');
  if (organization !== undefined) out.organization = organization;
  const datastore = str('datastore');
  if (datastore !== undefined) out.datastore = datastore;
  const revisions = field('revision');
  if (Array.isArray(revisions)) {
    out.revisions = (revisions as Record<string, string>[]).map((r) => (r['description'] === undefined ? { date: r['date']! } : { date: r['date']!, description: r['description'] }));
  }
  const timestamp = str('timestamp');
  if (timestamp !== undefined) out.timestamp = timestamp;
  return out;
}

export interface InstanceDataWriteOptions {
  readonly format: 'xml' | 'json';
  /**
   * How to name the content's schema in the header, when the header
   * doesn't give one: `modules`, the implemented modules with revisions
   * (`simplified-inline`; the default); `inline`, the schema as YANG
   * library data, with features and deviations; or `none`.
   */
  readonly contentSchema?: 'modules' | 'inline' | 'none';
  /** Indentation, as for JSON.stringify and the XML serializer. Default none. */
  readonly indent?: number;
  /** Apply this with-defaults mode to the content first (changing the tree in place), and record it as the header's `includes-defaults`. */
  readonly withDefaults?: WithDefaultsMode;
}

/**
 * Writes a data tree as an instance-data file (RFC 9195). Header fields
 * come from `header`; the content schema, unless given there, from the
 * tree's schema. The datastore defaults to the schema's.
 */
export async function writeInstanceData(tree: DataTree, header: InstanceDataHeader, options: InstanceDataWriteOptions): Promise<string> {
  const schema = await instanceDataSchema();
  if (options.withDefaults !== undefined) applyWithDefaults(tree, options.withDefaults);
  const datastore = header.datastore ?? tree.schema.datastore;
  const contentSchema: ContentSchema | 'inline-from-tree' | undefined =
    header.contentSchema ??
    (options.contentSchema === 'none'
      ? undefined
      : options.contentSchema === 'inline'
        ? 'inline-from-tree'
        : { kind: 'modules', modules: tree.schema.implemented.map((m) => (m.revision === undefined ? { name: m.name } : { name: m.name, revision: m.revision })) });

  let inline: JsonValue | undefined;
  const cs: Record<string, JsonValue> = {};
  if (contentSchema === 'inline-from-tree') inline = yangLibraryData(tree.schema, datastore === undefined ? {} : { datastores: [datastore] });
  else if (contentSchema?.kind === 'inline') inline = libraryJson(contentSchema.library);
  else if (contentSchema?.kind === 'modules') cs['module'] = contentSchema.modules.map((m) => (m.revision === undefined ? m.name : `${m.name}@${m.revision}`));
  else if (contentSchema?.kind === 'uri') cs['same-schema-as-file'] = contentSchema.uri;
  if (inline !== undefined) cs['inline-yang-library'] = {};

  const includes = options.withDefaults ?? header.includesDefaults;
  const body: Record<string, JsonValue> = {
    ...(header.name === undefined ? {} : { name: header.name }),
    ...(header.formatVersion === undefined ? {} : { 'format-version': header.formatVersion }),
    ...(includes === undefined ? {} : { 'includes-defaults': includes }),
    ...(Object.keys(cs).length === 0 ? {} : { 'content-schema': cs }),
    ...(header.description === undefined ? {} : { description: [...header.description] }),
    ...(header.contact === undefined ? {} : { contact: header.contact }),
    ...(header.organization === undefined ? {} : { organization: header.organization }),
    ...(datastore === undefined ? {} : { datastore }),
    ...(header.revisions === undefined ? {} : { revision: header.revisions.map((r) => ({ ...r })) }),
    ...(header.timestamp === undefined ? {} : { timestamp: header.timestamp }),
    'content-data': {},
  };
  const out = decodeJson(schema, { [STRUCTURE]: body }, { type: 'structure', structure: STRUCTURE });
  const set = out.children[0] as InstanceNode & { children: InstanceNode[] };
  const anydata = (parent: { children: readonly InstanceNode[] }, name: string): AnyInstance | undefined => {
    for (const c of parent.children) {
      if (c instanceof AnyInstance && c.schema.name === name) return c;
      if ('children' in c) {
        const found = anydata(c, name);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const content = anydata(set, 'content-data')!;
  const library = anydata(set, 'inline-yang-library');
  if (options.format === 'xml') {
    content.content = { format: 'xml', nodes: encodeXml(tree) };
    if (library !== undefined && inline !== undefined) {
      library.content = { format: 'xml', nodes: encodeXml(decodeJson(await yangLibrarySchema(), inline)) };
    }
    const text = serializeXml(encodeXml(out), options.indent === undefined ? {} : { indent: options.indent });
    return `<?xml version="1.0" encoding="UTF-8"?>\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  }
  content.content = { format: 'json', value: encodeJson(tree) };
  if (library !== undefined && inline !== undefined) library.content = { format: 'json', value: inline };
  return `${JSON.stringify(encodeJson(out), null, options.indent)}\n`;
}

/** YANG library data in RFC 7951 JSON, from the parsed form: what the header's inline-yang-library holds. */
function libraryJson(library: YangLibrary): JsonValue {
  const ref = (m: ModuleRef): Record<string, JsonValue> => ({ name: m.name, ...(m.revision === undefined ? {} : { revision: m.revision }) });
  return {
    'ietf-yang-library:yang-library': {
      'module-set': library.moduleSets.map((set) => ({
        name: set.name,
        module: set.modules.map((m) => ({
          ...ref(m),
          ...(m.namespace === undefined ? {} : { namespace: m.namespace }),
          ...(m.locations.length === 0 ? {} : { location: [...m.locations] }),
          ...(m.submodules.length === 0 ? {} : { submodule: m.submodules.map(ref) }),
          ...(m.features.length === 0 ? {} : { feature: [...m.features] }),
          ...(m.deviations.length === 0 ? {} : { deviation: m.deviations.map((d) => d.name) }),
        })),
        ...(set.importOnly.length === 0
          ? {}
          : {
              'import-only-module': set.importOnly.map((m) => ({
                ...ref(m),
                ...(m.namespace === undefined ? {} : { namespace: m.namespace }),
                ...(m.submodules.length === 0 ? {} : { submodule: m.submodules.map(ref) }),
              })),
            }),
      })),
      schema: library.schemas.map((s) => ({ name: s.name, 'module-set': [...s.moduleSets] })),
      ...(library.datastores.length === 0 ? {} : { datastore: library.datastores.map((d) => ({ ...d })) }),
      'content-id': library.contentId ?? '0',
    },
  };
}
