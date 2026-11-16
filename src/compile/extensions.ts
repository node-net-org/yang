/**
 * Handlers for extensions the compiler knows: `md:annotation` (RFC 7952),
 * `sx:structure` and `sx:augment-structure` (RFC 8791), `rc:yang-data`
 * (RFC 8040 §8). Every other extension is kept on its node as an
 * {@link ExtensionInstance} and otherwise ignored.
 *
 * A handler is matched by the module that defines the extension and the
 * extension's name, so a module may import the defining module under any
 * prefix. Handlers see top-level instances only, which is where all of
 * these may appear. New ones plug in here rather than into the compiler.
 */

import { substatement, type Statement } from '../parse/statement.js';
import type { SchemaNode, StructureDefinition } from '../schema/model.js';
import { splitRef, statusOf, type CompileContext, type MutableModule } from './context.js';
import type { MNode, TreeBuilder } from './compiler.js';
import type { LoadedFile, LoadedModule } from './loader.js';

/** What a handler can use. */
export interface ExtensionApi {
  readonly ctx: CompileContext;
  readonly builder: TreeBuilder;
}

export interface ExtensionHandler {
  /** The module defining the extension. */
  readonly module: string;
  /** The extension's name. */
  readonly name: string;
  /**
   * When the handler runs: `build`, as an implemented module's nodes are
   * built (before augments); `augment`, after every top-level augment, for
   * statements that add to what `build` made; `finish`, at the end, for
   * every loaded module, implemented or not.
   */
  readonly phase: 'build' | 'augment' | 'finish';
  handle(statement: Statement & { argument: string }, file: LoadedFile, module: MutableModule, api: ExtensionApi): void;
}

const annotation: ExtensionHandler = {
  module: 'ietf-yang-metadata',
  name: 'annotation',
  phase: 'finish',
  handle(s, file, module, { ctx, builder }) {
    const typeStatement = substatement(s, 'type');
    if (typeStatement === undefined) ctx.error('missing-annotation-type', `annotation '${s.argument}' has no type`, s);
    const units = substatement(s, 'units')?.argument;
    const description = substatement(s, 'description')?.argument;
    module.annotations.set(s.argument, {
      module,
      name: s.argument,
      type: typeStatement === undefined ? undefined : builder.types.resolve(typeStatement, { file, statement: s, parent: { file } }),
      status: statusOf(s),
      ...(units === undefined ? {} : { units }),
      ...(description === undefined ? {} : { description }),
    });
  },
};

function addStructure(module: MutableModule, s: Statement & { argument: string }, extension: 'structure' | 'yang-data', nodes: readonly MNode[], ctx: CompileContext): void {
  if (module.structures.has(s.argument)) {
    ctx.error('duplicate-definition', `${extension} '${s.argument}' is already defined in module ${module.name}`, s);
    return;
  }
  const description = substatement(s, 'description')?.argument;
  const def: StructureDefinition = {
    module,
    name: s.argument,
    extension,
    nodes: nodes as unknown as StructureDefinition['nodes'],
    status: statusOf(s),
    ...(description === undefined ? {} : { description }),
    statement: s,
  };
  module.structures.set(s.argument, def);
}

const structure: ExtensionHandler = {
  module: 'ietf-yang-structure-ext',
  name: 'structure',
  phase: 'build',
  handle(s, file, module, { ctx, builder }) {
    const container = builder.structureContainer(s, file, module);
    container.children = builder.buildDetached(s, file, module, container);
    addStructure(module, s, 'structure', [container], ctx);
  },
};

const yangData: ExtensionHandler = {
  module: 'ietf-restconf',
  name: 'yang-data',
  phase: 'build',
  handle(s, file, module, { ctx, builder }) {
    const nodes = builder.buildDetached(s, file, module, undefined);
    if (nodes.length !== 1 || nodes[0]!.kind !== 'container') {
      ctx.warning('invalid-yang-data', `yang-data '${s.argument}' should define exactly one container (RFC 8040 §8)`, s);
    }
    addStructure(module, s, 'yang-data', nodes, ctx);
  },
};

const augmentStructure: ExtensionHandler = {
  module: 'ietf-yang-structure-ext',
  name: 'augment-structure',
  phase: 'augment',
  handle(s, file, module, { ctx, builder }) {
    // The first step names a structure, the rest a node in it (RFC 8791 §2.2).
    const steps = s.argument.trim().replace(/^\//, '').split('/');
    let target: MNode | undefined;
    for (const [i, step] of steps.entries()) {
      const parts = splitRef(step.trim());
      const owner = parts === undefined ? undefined : ctx.moduleFor(parts.prefix, file);
      if (parts === undefined || owner === undefined) {
        target = undefined;
        break;
      }
      if (i === 0) {
        target = owner.structures.get(parts.name)?.nodes[0] as MNode | undefined;
        if (owner.structures.get(parts.name)?.extension !== 'structure') target = undefined;
      } else {
        target = target?.children.find((c) => c.name === parts.name && c.module === owner);
      }
      if (target === undefined) break;
    }
    if (target === undefined) {
      ctx.error('augment-target-not-found', `augment-structure target '${s.argument}' was not found`, s);
      return;
    }
    const nodes = builder.augment(target, s, { file }, module);
    if (nodes.length > 0) module.structureAugments.push({ path: s.argument, target: target as unknown as SchemaNode, nodes: nodes as unknown as SchemaNode[], statement: s });
  },
};

const HANDLERS: readonly ExtensionHandler[] = [annotation, structure, yangData, augmentStructure];

/** Runs the handlers of one phase over a module's top-level extension statements, in every file of the module. */
export function runExtensions(phase: ExtensionHandler['phase'], loaded: LoadedModule, module: MutableModule, api: ExtensionApi): void {
  for (const file of loaded.files) {
    for (const s of file.statement.substatements) {
      if (s.prefix === undefined || s.argument === undefined) continue;
      const definer = file.prefixes.get(s.prefix);
      const name = s.keyword.slice(s.prefix.length + 1);
      const handler = HANDLERS.find((h) => h.phase === phase && h.module === definer && h.name === name);
      if (handler === undefined || !api.ctx.enabled(s, file)) continue;
      handler.handle(s as Statement & { argument: string }, file, module, api);
    }
  }
}
