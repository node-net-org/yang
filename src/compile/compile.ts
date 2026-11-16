/**
 * The compiler's entry point.
 */

import type { Diagnostic } from '../location.js';
import { substatements, type Statement } from '../parse/statement.js';
import { Schema } from '../schema/schema.js';
import type { CompiledModule, SchemaNode, YangType } from '../schema/model.js';
import type { ModuleSource } from '../source/source.js';
import { written } from '../schema/written.js';
import { CompileContext, splitRef, type MutableModule } from './context.js';
import { TreeBuilder, type MNode } from './compiler.js';
import { runExtensions } from './extensions.js';
import { checkLeafrefPath, checkXPath, type CheckScope } from '../xpath/check.js';
import { analyseSchemaPaths } from '../xpath/schema-paths.js';
import { loadModules, type LoadedFile, type LoadedModule, type ModuleRequest } from './loader.js';

export interface CompileOptions {
  /** Where to find modules: the requested ones and everything they import. */
  readonly source: ModuleSource;
  /** The modules to implement, by name, or by name and revision. Their imports are loaded too, as import-only modules. */
  readonly modules: readonly (string | ModuleRequest)[];
  /**
   * Enabled features, per module name. Modules not listed have every
   * feature enabled. List a module with an empty array to disable all of
   * its features.
   */
  readonly features?: Readonly<Record<string, readonly string[]>>;
  /**
   * Modules to load but not implement, by name or by name and revision, as
   * a YANG library's import-only modules. A module may be listed in more
   * than one revision.
   */
  readonly importOnly?: readonly (string | ModuleRequest)[];
  /** Revisions of submodules, used for includes that don't give a revision date. */
  readonly submodules?: readonly ModuleRequest[];
  /**
   * Whether features of modules that are only imported are enabled (as
   * `features` says, or all of them). Default true. A YANG library lists
   * features for implemented modules only, so a schema built from one sets
   * this false, as libyang does.
   */
  readonly importOnlyFeatures?: boolean;
  /**
   * Keep the parsed statements the schema was compiled from, on its nodes,
   * modules, includes, augments and structures. Default false: they are
   * released once the schema is compiled, which roughly halves the memory a
   * large schema keeps. Set it for tools that need the source statements.
   * Extension uses keep their statements either way.
   */
  readonly keepStatements?: boolean;
}

/**
 * Loads and compiles a set of modules into a {@link Schema}.
 *
 * Problems are reported in `schema.diagnostics`, never thrown. A schema with
 * errors is still returned and may be usable, but parts of it may be missing.
 */
export async function compileSchema(options: CompileOptions): Promise<Schema> {
  const request = (m: string | ModuleRequest): ModuleRequest => (typeof m === 'string' ? { name: m } : m);
  const loaded = await loadModules(
    { implement: options.modules.map(request), importOnly: (options.importOnly ?? []).map(request), submodules: options.submodules ?? [] },
    options.source,
  );
  const ctx = new CompileContext(loaded.modules, options.features, options.importOnlyFeatures ?? true);
  ctx.diagnostics.push(...loaded.diagnostics);
  ctx.createModules();
  ctx.createFeatures();
  ctx.createIdentities();
  ctx.createExtensions();
  ctx.checkExtensionVisibility();

  implementAugmentTargets(loaded.order, ctx);
  const builder = new TreeBuilder(ctx);
  const api = { ctx, builder };
  builder.onModuleBuilt = (m) => runExtensions('build', ctx.loaded.get(ctx.keyOf(m))!, m, api);
  const implementedCount = (): number => [...ctx.compiled.values()].filter((m) => m.implemented).length;
  for (const m of loaded.order) {
    if (m.implemented) builder.buildModule(ctx.compiled.get(m.key)!);
  }

  // Top-level augments, until none applies any more. Implementing a module
  // can bring in more augments and leafrefs, which can implement more
  // modules, so repeat until the set of implemented modules stops growing.
  let pending: { statement: Statement; file: LoadedFile }[] = [];
  const queued = new Set<string>();
  for (;;) {
    const before = implementedCount();
    for (const m of loaded.order) {
      if (!ctx.compiled.get(m.key)!.implemented || queued.has(m.key)) continue;
      queued.add(m.key);
      builder.buildModule(ctx.compiled.get(m.key)!);
      for (const file of augmentOrder(m)) for (const a of substatements(file.statement, 'augment')) pending.push({ statement: a, file });
    }
    for (let progress = true; progress && pending.length > 0; ) {
      progress = false;
      const next: typeof pending = [];
      for (const p of pending) {
        const target = resolveAbsolute(p.statement.argument ?? '', p.file, ctx, builder, true);
        if (target === null) {
          progress = true; // an if-feature removed the target: nothing to add to
          continue;
        }
        if (target === undefined) {
          next.push(p);
          continue;
        }
        const module = ctx.compiled.get(p.file.module.key)!;
        const nodes = builder.augment(target, p.statement, { file: p.file }, module);
        if (nodes.length > 0) {
          module.augments.push({ path: p.statement.argument ?? '', target: target as unknown as SchemaNode, nodes: nodes as unknown as SchemaNode[], statement: p.statement });
        }
        progress = true;
      }
      pending = next;
    }
    // A leafref into another module's data needs that module implemented (as libyang does).
    for (const name of builder.leafrefModules()) {
      const m = ctx.compiled.get(name);
      if (m !== undefined && !m.implemented) {
        m.implemented = true;
        builder.buildModule(m);
      }
    }
    if (implementedCount() === before && [...ctx.compiled.values()].every((m) => !m.implemented || queued.has(ctx.keyOf(m)))) break;
  }
  for (const p of pending) ctx.error('augment-target-not-found', `augment target '${p.statement.argument ?? ''}' was not found`, p.statement);

  // Extensions that add to what was built: sx:augment-structure.
  for (const m of loaded.order) if (ctx.compiled.get(m.key)!.implemented) runExtensions('augment', m, ctx.compiled.get(m.key)!, api);

  // Deviations from implemented modules.
  for (const m of loaded.order) {
    if (!ctx.compiled.get(m.key)!.implemented) continue;
    for (const file of m.files) {
      for (const d of substatements(file.statement, 'deviation')) {
        const target = resolveAbsolute(d.argument ?? '', file, ctx, builder, false);
        if (target === null) continue;
        if (target === undefined) {
          ctx.error('deviation-target-not-found', `deviation target '${d.argument ?? ''}' was not found in an implemented module`, d);
          continue;
        }
        // The deviated module is the one the path starts in, as libyang records it.
        const first = splitRef((d.argument ?? '').trim().replace(/^\//, '').split('/')[0]!.trim());
        const deviated = ctx.moduleFor(first?.prefix, file);
        if (deviated !== undefined && deviated !== ctx.compiled.get(m.key) && !deviated.deviations.includes(m.name)) deviated.deviations.push(m.name);
        builder.deviate(target, d, file, (n) => removeFromTree(n, n.module));
      }
    }
  }

  const roots = (): MNode[] =>
    [...ctx.compiled.values()].filter((m) => m.implemented).flatMap((m) => [...m.dataNodes, ...m.rpcs, ...m.notifications] as unknown as MNode[]);
  builder.finish(roots);
  // Extensions of every loaded module: md:annotation, usable wherever its module is known.
  for (const m of loaded.order) runExtensions('finish', m, ctx.compiled.get(m.key)!, api);
  checkExpressions(ctx, builder);

  const schema = new Schema(ctx.compiled, dedupe(ctx.diagnostics));
  builder.typeDefaults(schema);
  releaseStatements(ctx.compiled.values(), options.keepStatements ?? false);
  return schema;
}

/**
 * Records what tree diagrams need from the statements of the schema's nodes,
 * then, unless they are kept, clears every statement the schema points to
 * except those of extension uses. Runs after everything that reads them.
 */
function releaseStatements(modules: Iterable<CompiledModule>, keep: boolean): void {
  const seen = new Set<SchemaNode>();
  const clear = (o: { readonly statement: Statement | undefined }): void => {
    if (!keep) (o as { statement: Statement | undefined }).statement = undefined;
  };
  const visit = (nodes: readonly SchemaNode[]): void => {
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      const s = n.statement;
      if (s !== undefined) {
        const key = n.kind === 'list' ? substatements(s, 'key')[0]?.argument : undefined;
        const io = n.kind === 'rpc' || n.kind === 'action' ? s.substatements.filter((x) => x.keyword === 'input' || x.keyword === 'output').map((x) => x.keyword as 'input' | 'output') : undefined;
        const config = substatements(s, 'config')[0]?.argument;
        if (key !== undefined || io !== undefined || config !== undefined) {
          written.set(n, { ...(key === undefined ? {} : { key }), ...(io === undefined ? {} : { io }), ...(config === undefined ? {} : { config }) });
        }
      }
      clear(n);
      visit(n.children);
    }
  };
  for (const m of modules) {
    visit(m.dataNodes);
    visit(m.rpcs);
    visit(m.notifications);
    for (const d of m.structures.values()) {
      visit(d.nodes);
      clear(d);
    }
    for (const a of [...m.augments, ...m.structureAugments]) {
      visit([a.target]);
      visit(a.nodes);
      clear(a);
    }
    for (const i of m.includes) clear(i);
    clear(m);
  }
}

/**
 * Implements every module an enabled top-level augment of an implemented
 * module names in its path (RFC 7950 §5.6.5), transitively, before anything
 * is built. They would be implemented anyway when the augment is applied;
 * knowing them up front lets their own augments apply in dependency order,
 * as pyang applies them.
 */
function implementAugmentTargets(order: readonly LoadedModule[], ctx: CompileContext): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of order) {
      if (!ctx.compiled.get(m.key)!.implemented) continue;
      for (const file of m.files) {
        for (const a of substatements(file.statement, 'augment')) {
          if (!ctx.enabled(a, file)) continue;
          for (const step of (a.argument ?? '').trim().replace(/^\//, '').split('/')) {
            const target = ctx.moduleFor(splitRef(step.trim())?.prefix, file);
            if (target !== undefined && !target.implemented) {
              target.implemented = true;
              ctx.loaded.get(ctx.keyOf(target))!.implemented = true;
              changed = true;
            }
          }
        }
      }
    }
  }
}

/**
 * A module's files in the order their augments apply: each included
 * submodule (depth first, in include order) before the file that includes
 * it, as pyang expands them.
 */
function augmentOrder(m: LoadedModule): LoadedFile[] {
  const byName = new Map(m.files.map((f) => [f.name, f]));
  const out: LoadedFile[] = [];
  const seen = new Set<LoadedFile>();
  const visit = (f: LoadedFile): void => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const inc of substatements(f.statement, 'include')) {
      const sub = byName.get(inc.argument ?? '');
      if (sub !== undefined) visit(sub);
    }
    out.push(f);
  };
  visit(m.files[0]!);
  for (const f of m.files) visit(f);
  return out;
}

/**
 * Finds the node an absolute schema node identifier names (RFC 7950 §6.5).
 * Null when an if-feature removed a node on the way.
 */
function resolveAbsolute(path: string, file: LoadedFile, ctx: CompileContext, builder: TreeBuilder, implement: boolean): MNode | undefined | null {
  const steps = path.trim().replace(/^\//, '').split('/');
  let candidates: MNode[] | undefined;
  let found: MNode | undefined;
  let parent: object | undefined;
  for (const step of steps) {
    const parts = splitRef(step.trim());
    if (parts === undefined) return undefined;
    const module = ctx.moduleFor(parts.prefix, file);
    if (module === undefined) return undefined;
    // Every module the path names must be implemented (RFC 7950 §5.6.5).
    if (!module.implemented) {
      if (!implement) return undefined;
      module.implemented = true;
    }
    builder.buildModule(module);
    candidates ??= [...module.dataNodes, ...module.rpcs, ...module.notifications] as unknown as MNode[];
    found = candidates.find((c) => c.name === parts.name && c.module.name === module.name);
    if (found === undefined) return builder.isDisabled(parent ?? module, parts.name) ? null : undefined;
    parent = found;
    candidates = found.children;
  }
  return found;
}

function removeFromTree(node: MNode, module: MutableModule): void {
  const parent = node.parent;
  if (parent !== undefined) {
    parent.children = parent.children.filter((c) => c !== node);
    return;
  }
  module.dataNodes = module.dataNodes.filter((n) => (n as unknown) !== node);
  module.rpcs = module.rpcs.filter((n) => (n as unknown) !== node);
  module.notifications = module.notifications.filter((n) => (n as unknown) !== node);
}

/** Groupings used many times report the same problem many times. Keep one of each. */
function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}|${d.message}|${d.location.source ?? ''}|${d.location.offset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parses the XPath of every `must`, `when` and leafref `path` in the
 * implemented modules' trees, structures included, and reports syntax
 * errors, unknown prefixes and functions, and leafref paths outside the
 * path grammar. The parsed forms are cached for validation. Then follows
 * the paths in every `must` and `when` through the schema, and looks for
 * `when` conditions that depend on each other (xpath/schema-paths.ts).
 */
function checkExpressions(ctx: CompileContext, builder: TreeBuilder): void {
  const byName = new Map<string, CompiledModule>();
  for (const m of ctx.compiled.values()) if (!byName.has(m.name) || m.implemented) byName.set(m.name, m);
  const seen = new Set<object>();
  const scope = (prefixes: ReadonlyMap<string, string>, version: '1' | '1.1'): CheckScope => ({ prefixes, yangVersion: version, module: (n) => byName.get(n) });
  const leafrefs = (node: SchemaNode, t: YangType): void => {
    if (t.builtin === 'union') for (const m of t.types ?? []) leafrefs(node, m);
    if (t.builtin !== 'leafref' || t.path === undefined || seen.has(t.path)) return;
    seen.add(t.path);
    for (const p of checkLeafrefPath(t.path, scope(t.path.prefixes, node.module.yangVersion))) ctx.report(p.severity, p.code, p.message, node.statement!.location);
  };
  const stack: SchemaNode[] = [];
  for (const m of ctx.compiled.values()) {
    if (!m.implemented) continue;
    stack.push(...m.dataNodes, ...m.rpcs, ...m.notifications, ...[...m.structures.values()].flatMap((x) => x.nodes));
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const x of [...node.when, ...node.must]) {
      if (seen.has(x)) continue;
      seen.add(x);
      for (const p of checkXPath(x, scope(x.prefixes, ctx.xpathVersions.get(x) ?? node.module.yangVersion))) ctx.report(p.severity, p.code, p.message, x.location);
    }
    if (node.kind === 'leaf' || node.kind === 'leaf-list') leafrefs(node, node.type);
    stack.push(...node.children);
  }

  const implemented = [...ctx.compiled.values()].filter((m) => m.implemented);
  const structures = new Map<SchemaNode, readonly SchemaNode[]>();
  for (const m of implemented) for (const s of m.structures.values()) for (const n of s.nodes) structures.set(n, s.nodes);
  const tops = [...implemented.flatMap((m) => [...m.dataNodes, ...m.rpcs, ...m.notifications]), ...structures.keys()];
  const problems = analyseSchemaPaths(tops, {
    implemented,
    module: (n) => byName.get(n),
    incomplete: (parent) => builder.isIncomplete(parent),
    structure: (top) => structures.get(top),
  });
  for (const p of problems) ctx.report('warning', p.code, p.message, p.expression.location);
}
