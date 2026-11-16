/**
 * Module sources: where the compiler gets YANG text from.
 *
 * A source is anything that can answer "give me module X (at revision R)".
 * Memory and the bundled IETF modules are built in here and need nothing from
 * Node.js; directories on disk are in files.ts, for the Node entry only.
 * Protocol packages add their own, such as @node-net/netconf fetching with
 * `<get-schema>`.
 */

import { parseModuleText } from '../parse/module.js';
import { decodeText } from '../parse/parser.js';

/** The text of one module or submodule. */
export interface ModuleText {
  /** The module's YANG or YIN source. */
  readonly text: string | Uint8Array;
  /** A name for the text, usually a file path. It appears in diagnostics. */
  readonly source?: string;
  /** YANG or YIN (RFC 7950 §13). Absent: YIN if the text starts with `<`, YANG otherwise. */
  readonly format?: 'yang' | 'yin';
}

/**
 * Where YANG module text comes from: anything that can return module X (at
 * revision R), such as `memorySource()` or the bundled IETF modules.
 */
export interface ModuleSource {
  /**
   * Finds a module or submodule. Without a revision, returns the latest
   * revision the source has. Resolves to `undefined` when it has none.
   */
  load(name: string, revision?: string): Promise<ModuleText | undefined>;
}

/** The latest revision date declared in a module's text, by a quick parse. Undefined when it has none or can't be parsed. */
export function declaredRevision(text: string | Uint8Array): string | undefined {
  try {
    const { statement } = parseModuleText({ text });
    return latestRevision(statement.substatements.filter((s) => s.keyword === 'revision').map((s) => s.argument ?? ''));
  } catch {
    return undefined;
  }
}

export function latestRevision(dates: readonly string[]): string | undefined {
  let latest: string | undefined;
  for (const d of dates) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (latest === undefined || d > latest)) latest = d;
  return latest;
}

/**
 * Modules held in memory. Each text is parsed once to learn its name and
 * latest revision. A text that can't be parsed is still found by the name
 * after its `module` or `submodule` keyword, so the compiler can report the
 * syntax error when the module is needed.
 */
export function memorySource(modules: Iterable<ModuleText | string>): ModuleSource {
  const index = new Map<string, { revision: string | undefined; module: ModuleText }[]>();
  for (const m of modules) {
    const module = typeof m === 'string' ? { text: m } : m;
    let name: string | undefined;
    let revision: string | undefined;
    try {
      const { statement } = parseModuleText({ ...module, text: decodeText(module.text) });
      name = statement.argument;
      revision = latestRevision(statement.substatements.filter((s) => s.keyword === 'revision').map((s) => s.argument ?? ''));
    } catch {
      try {
        const t = decodeText(module.text);
        name = /^\s*(?:sub)?module\s+([A-Za-z_][A-Za-z0-9_.-]*)/.exec(t)?.[1] ?? /<(?:sub)?module\s[^>]*?name\s*=\s*["']([A-Za-z_][A-Za-z0-9_.-]*)/.exec(t)?.[1];
      } catch {
        continue; // not even UTF-8
      }
    }
    if (name === undefined) continue;
    const list = index.get(name) ?? [];
    list.push({ revision, module });
    index.set(name, list);
  }
  return {
    load(name, revision) {
      const list = index.get(name) ?? [];
      const found =
        revision === undefined
          ? [...list].sort((a, b) => ((a.revision ?? '') < (b.revision ?? '') ? 1 : -1))[0]
          : list.find((e) => e.revision === revision);
      return Promise.resolve(found?.module);
    },
  };
}

/** Tries each source in turn. */
export function chainSources(...sources: readonly ModuleSource[]): ModuleSource {
  return {
    async load(name, revision) {
      for (const source of sources) {
        const found = await source.load(name, revision);
        if (found !== undefined) return found;
      }
      return undefined;
    },
  };
}

/**
 * The IETF modules bundled with @node-net/yang (see modules/README.md): the common
 * types, metadata, structure extensions, datastores, YANG library (with RFC
 * 10035's augmented-by), instance data, RESTCONF, NACM, NETCONF and
 * with-defaults modules. They are embedded in the library (generated from
 * modules/ by scripts/gen-builtin-modules.mjs), so they need no filesystem.
 * The text is loaded with import() and indexed the first time a module is
 * asked for, so a bundler puts it in a chunk of its own, fetched only by an
 * app that looks a module up here.
 */
export const builtinSource: ModuleSource = {
  async load(name, revision) {
    if (builtins === undefined) {
      const loading = import('./builtin-modules.js').then(({ BUILTIN_MODULES }) =>
        memorySource(BUILTIN_MODULES.map((m) => ({ text: m.text, source: `@node-net/yang/modules/${m.file}`, format: 'yang' as const }))),
      );
      builtins = loading;
      // A failed load (a chunk the browser couldn't fetch) isn't kept, so the next lookup tries again.
      loading.catch(() => {
        if (builtins === loading) builtins = undefined;
      });
    }
    return (await builtins).load(name, revision);
  },
};

let builtins: Promise<ModuleSource> | undefined;
