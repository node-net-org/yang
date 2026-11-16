import { builtinSource, chainSources, compileSchema, memorySource, type Schema, type SchemaNode } from '../../src/index.js';

/** A module named `name` with namespace urn:<name> and prefix = name, around `body`. */
export function mod(name: string, body: string, header = ''): string {
  return `module ${name} {\n  yang-version 1.1;\n  namespace "urn:${name}";\n  prefix ${name};\n${header}\n${body}\n}\n`;
}

/** Compiles in-memory modules (plus the bundled IETF ones). The first text is implemented unless `implement` says otherwise. */
export async function compile(
  texts: string[],
  options: { implement?: string[]; features?: Record<string, string[]> } = {},
): Promise<Schema> {
  const first = /^\s*module\s+(\S+)/.exec(texts[0]!)![1]!;
  return compileSchema({
    source: chainSources(memorySource(texts.map((text, i) => ({ text, source: `m${i}.yang` }))), builtinSource),
    modules: options.implement ?? [first],
    ...(options.features === undefined ? {} : { features: options.features }),
  });
}

export function errorCodes(schema: Schema): string[] {
  return schema.errors.map((e) => e.code);
}

/** The node at a data path, failing the test if it isn't there. */
export function node<T extends SchemaNode = SchemaNode>(schema: Schema, path: string): T {
  const n = schema.find(path);
  if (n === undefined) throw new Error(`no node at ${path}; diagnostics: ${JSON.stringify(schema.diagnostics.map((d) => d.message))}`);
  return n as T;
}

export function names(nodes: readonly SchemaNode[]): string[] {
  return nodes.map((n) => n.name);
}
