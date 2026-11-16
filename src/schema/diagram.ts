/**
 * YANG tree diagrams (RFC 8340, updated by RFC 8791 for structures), from a
 * compiled schema.
 *
 * The layout is pyang's `-f tree`, character for character: the column the
 * types line up in, where long lines fold, and when sections are printed.
 * RFC 8340's own diagrams come from pyang, so its output is the reference.
 */

import type { CompiledModule, SchemaNode } from './model.js';
import type { Schema } from './schema.js';
import { written } from './written.js';

export interface TreeDiagramOptions {
  /**
   * The modules to print, in order. Default: every implemented module, by
   * name. A module's augments of another module printed here appear in
   * that module's tree rather than as an augment section.
   */
  readonly modules?: readonly string[];
  /** Fold lines longer than this (pyang `--tree-line-length`). Default: no folding. */
  readonly lineLength?: number;
  /** Print only this many levels (pyang `--tree-depth`). */
  readonly depth?: number;
  /** Print only the subtree at this path of node names, `/`-separated, without prefixes (pyang `--tree-path`). */
  readonly path?: string;
  /** Print structures and yang-data sections (RFC 8791 §2.3; pyang `--tree-print-structures --tree-print-yang-data`). Default true. */
  readonly structures?: boolean;
}

type Mode = 'data' | 'augment' | 'input' | 'output' | 'rpc' | 'notification' | 'structure' | 'yang-data';

/** Prints the tree diagram of a schema's modules, as `pyang -f tree` does. */
export function treeDiagram(schema: Schema, options: TreeDiagramOptions = {}): string {
  const names = options.modules ?? schema.implemented.map((m) => m.name).sort();
  const modules = names.map((n) => schema.module(n)).filter((m): m is CompiledModule => m !== undefined);
  const out: string[] = [];
  const p = new Printer(out, options.lineLength, options.depth);
  const path = options.path === undefined ? undefined : options.path.split('/').filter((s, i) => !(i === 0 && s === ''));
  let printedHeader = false;

  for (const module of modules) {
    if (printedHeader) out.push('\n');
    printedHeader = false;
    const header = (): void => {
      if (!printedHeader) out.push(`module: ${module.name}\n`);
      printedHeader = true;
    };
    const filter = (nodes: readonly SchemaNode[]): { nodes: readonly SchemaNode[]; rest: string[] | undefined } => {
      if (path === undefined) return { nodes, rest: undefined };
      if (path.length === 0) return { nodes: [], rest: [] };
      return { nodes: nodes.filter((n) => n.name === path[0]), rest: path.slice(1) };
    };

    const data = filter(module.dataNodes);
    if (data.nodes.length > 0) {
      header();
      p.children(data.nodes, module, '', data.rest, 'data', options.depth);
    }

    let delimiter = false;
    for (const a of module.augments) {
      if (modules.includes(a.target.module)) continue;
      header();
      if (!delimiter) out.push('\n');
      delimiter = true;
      p.path('  augment', ':', a.path);
      const kind = a.target.kind;
      const mode: Mode = kind === 'input' ? 'input' : kind === 'output' ? 'output' : kind === 'notification' ? 'notification' : 'augment';
      p.children(
        a.nodes.filter((n) => (a.target.children as readonly SchemaNode[]).includes(n)),
        module,
        '  ',
        path,
        mode,
        options.depth,
      );
    }

    const rpcs = path !== undefined && path.length === 0 ? { nodes: [], rest: [] } : filter(module.rpcs);
    if (rpcs.nodes.length > 0) {
      header();
      out.push('\n  rpcs:\n');
      p.children(rpcs.nodes, module, '  ', rpcs.rest, 'rpc', options.depth);
    }
    const notifications = path !== undefined && path.length === 0 ? { nodes: [], rest: [] } : filter(module.notifications);
    if (notifications.nodes.length > 0) {
      header();
      out.push('\n  notifications:\n');
      p.children(notifications.nodes, module, '  ', notifications.rest, 'notification', options.depth);
    }

    if (options.structures ?? true) {
      const structures = [...module.structures.values()];
      const sections: { heading: string; nodes: readonly SchemaNode[]; mode: Mode }[][] = [
        structures.filter((x) => x.extension === 'yang-data').map((x) => ({ heading: `yang-data ${x.name}`, nodes: x.nodes, mode: 'yang-data' })),
        // A structure is encoded as a container named after it; the diagram shows what is inside.
        structures.filter((x) => x.extension === 'structure').map((x) => ({ heading: `structure ${x.name}`, nodes: x.nodes[0]?.children ?? [], mode: 'structure' })),
        module.structureAugments.map((a) => ({ heading: `augment-structure ${a.path}`, nodes: a.nodes, mode: 'structure' })),
      ];
      for (const group of sections) {
        let first = true;
        for (const s of group) {
          header();
          if (first) out.push('\n');
          first = false;
          out.push(`  ${s.heading}:\n`);
          p.children(s.nodes, module, '  ', path, s.mode, options.depth);
        }
      }
    }
  }
  return out.join('');
}

class Printer {
  constructor(
    readonly out: string[],
    readonly llen: number | undefined,
    readonly depth: number | undefined,
  ) {}

  /** An augment path, folded at `/` when too long. */
  path(pre: string, post: string, path: string): void {
    const line = `${pre} ${path}${post}`;
    if (this.llen === undefined || line.length <= this.llen) {
      this.out.push(`${line}\n`);
      return;
    }
    let parts = path.split('/');
    if (parts[0] === '') parts = parts.slice(1);
    const comps = (pre: string, p: string[], isFirst: boolean): void => {
      let line = `${pre}/${p[0]!}`;
      p = p.slice(1);
      if (line.length <= this.llen!) {
        while (p.length > 0 && line.length + 1 + p[0]!.length <= this.llen!) {
          if (p.length === 1 && line.length + 1 + p[0]!.length + post.length > this.llen!) break;
          line += `/${p[0]!}`;
          p = p.slice(1);
        }
      }
      if (p.length === 0) line += post;
      this.out.push(`${line}\n`);
      if (p.length > 0) comps(isFirst ? ' '.repeat(pre.length + 2) : pre, p, false);
    };
    comps(`${pre} `, parts, true);
  }

  children(nodes: readonly SchemaNode[], module: CompiledModule, prefix: string, path: string[] | undefined, mode: Mode, depth: number | undefined, width = 0): void {
    if (depth === 0) {
      if (nodes.length > 0) this.out.push(`${prefix}     ...\n`);
      return;
    }
    const nameLength = (n: SchemaNode): number => (n.module.name === module.name ? n.name.length : n.module.prefix.length + 1 + n.name.length);
    const getWidth = (w: number, chs: readonly SchemaNode[]): number => {
      for (const ch of chs) {
        const len = ch.kind === 'choice' || ch.kind === 'case' ? 3 + getWidth(0, ch.children) : nameLength(ch);
        if (len > w) w = len;
      }
      return w;
    };
    if (width === 0) width = getWidth(0, nodes);
    const last = nodes[nodes.length - 1];
    for (const ch of nodes) {
      if ((ch.kind === 'input' || ch.kind === 'output') && ch.children.length === 0) continue;
      const newPrefix = ch === last || (last?.kind === 'output' && last.children.length === 0) ? `${prefix}   ` : `${prefix}  |`;
      if (ch.kind === 'input') mode = 'input';
      else if (ch.kind === 'output') mode = 'output';
      this.node(ch, module, newPrefix, path, mode, depth, width);
    }
  }

  node(s: SchemaNode, module: CompiledModule, prefix: string, path: string[] | undefined, mode: Mode, depth: number | undefined, width: number): void {
    const llen = this.llen;
    let line = `${prefix.slice(0, -1)}${status(s)}--`;
    let brcol = line.length + 4;
    let name = s.module.name === module.name ? s.name : `${s.module.prefix}:${s.name}`;
    const flags = flagsOf(s, mode);
    const pad = (text: string, n: number): string => text + ' '.repeat(Math.max(0, n - text.length));
    switch (s.kind) {
      case 'list':
        name += '*';
        line += `${flags} ${name}`;
        break;
      case 'container':
        if (s.presence !== undefined) name += '!';
        line += `${flags} ${name}`;
        break;
      case 'choice':
        line += s.mandatory ? `${flags} (${name})` : `${flags} (${name})?`;
        break;
      case 'case':
        line += `:(${name})`;
        brcol += 1;
        break;
      default: {
        if (s.kind === 'leaf-list') name += '*';
        else if ((s.kind === 'leaf' && !s.isKey) || s.kind === 'anydata' || s.kind === 'anyxml') {
          if (!('mandatory' in s) || !s.mandatory) name += '?';
        }
        const t = typeName(s);
        if (t === '') line += `${flags} ${name}`;
        else if (llen !== undefined && line.length + flags.length + width + 1 + t.length + 4 > llen) {
          // No room for the type name.
          if (isLeafref(s) && t.length + brcol > llen) {
            if (line.length + flags.length + width + 1 + 7 + 4 > llen) {
              line += `${flags} ${name}`;
              this.out.push(`${line}\n`);
              line = `${prefix}${' '.repeat(brcol - prefix.length)} leafref`;
            } else line += `${flags} ${pad(name, width + 1)}   leafref`;
          } else {
            line += `${flags} ${name}`;
            this.out.push(`${line}\n`);
            line = `${prefix}${' '.repeat(brcol - prefix.length)} ${t}`;
          }
        } else line += `${flags} ${pad(name, width + 1)}   ${t}`;
      }
    }
    if (s.kind === 'list') {
      const keys = (written.get(s)?.key ?? '').trim();
      if (keys !== '' || s.keys.length > 0) {
        const keystr = ` [${keys.split(/\s+/).join(' ')}]`;
        if (llen !== undefined && line.length + keystr.length > llen) {
          this.out.push(`${line}\n`);
          line = `${prefix}${' '.repeat(brcol - prefix.length)}`;
        }
        line += keystr;
      } else line += ' []';
    }
    if (s.ifFeatures.length > 0) {
      const fstr = ` {${s.ifFeatures.join(',')}}?`;
      if (llen !== undefined && line.length + fstr.length > llen) {
        this.out.push(`${line}\n`);
        line = `${prefix}${' '.repeat(brcol - prefix.length)}`;
      }
      line += fstr;
    }
    this.out.push(`${line}\n`);
    let chs: readonly SchemaNode[] = childrenOf(s);
    if (depth !== undefined) depth -= 1;
    if (path !== undefined && path.length > 0) {
      const step = path[0];
      chs = chs.filter((c) => c.name === step);
      path = path.slice(1);
    }
    if (s.kind === 'choice' || s.kind === 'case') this.children(chs, module, prefix, path, mode, depth, width - 3);
    else this.children(chs, module, prefix, path, mode, depth);
  }
}

/**
 * Children as pyang lists them: for an RPC or action, an input or output
 * that isn't written comes first (it is created before the written ones are
 * added), and written ones follow in source order.
 */
function childrenOf(s: SchemaNode): readonly SchemaNode[] {
  if (s.kind !== 'rpc' && s.kind !== 'action') return s.children;
  const io = written.get(s)?.io ?? [];
  const implicit = s.children.filter((c) => !(io as readonly string[]).includes(c.kind));
  const explicit = io.map((k) => s.children.find((c) => c.kind === k)!);
  return [...implicit, ...explicit];
}

/** Whether a node is inside a notification, where pyang gives data nodes no config flag. */
function inNotification(s: SchemaNode): boolean {
  for (let p = s.parent; p !== undefined; p = p.parent) if (p.kind === 'notification') return true;
  return false;
}

function status(s: SchemaNode): string {
  return s.status === 'deprecated' ? 'x' : s.status === 'obsolete' ? 'o' : '+';
}

function flagsOf(s: SchemaNode, mode: Mode): string {
  if (mode === 'input') return '-w';
  if (s.kind === 'rpc' || s.kind === 'action') return '-x';
  if (s.kind === 'notification') return '-n';
  if (mode === 'output' || mode === 'notification') return 'ro';
  if (mode === 'structure' || mode === 'yang-data') {
    // pyang gives structure nodes a config flag only where a config statement says so.
    for (let n: SchemaNode | undefined = s; n !== undefined; n = n.parent) {
      const config = written.get(n)?.config;
      if (config !== undefined) return config === 'true' ? 'rw' : 'ro';
    }
    return '';
  }
  if (inNotification(s)) return '';
  return s.config ? 'rw' : 'ro';
}

function isLeafref(s: SchemaNode): boolean {
  return (s.kind === 'leaf' || s.kind === 'leaf-list') && s.type.name === 'leafref';
}

/** The type as written, a leafref as `-> path` with prefixes kept only where the module changes. */
function typeName(s: SchemaNode): string {
  if (s.kind === 'anydata') return '<anydata>';
  if (s.kind === 'anyxml') return '<anyxml>';
  if (s.kind !== 'leaf' && s.kind !== 'leaf-list') return '';
  const t = s.type;
  if (t.name !== 'leafref' || t.path === undefined) return t.name;
  const target: string[] = [];
  let current = s.module.prefix;
  for (const part of t.path.text.split('/')) {
    const colon = part.indexOf(':');
    const prefix = colon === -1 ? undefined : part.slice(0, colon);
    const name = colon === -1 ? part : part.slice(colon + 1);
    if (prefix === undefined || prefix === current) target.push(name);
    else {
      target.push(`${prefix}:${name}`);
      current = prefix;
    }
  }
  return `-> ${target.join('/')}`;
}
