/**
 * instance-identifier values (RFC 7950 §9.13, §14; RFC 7951 §6.11):
 *
 *   instance-identifier = 1*("/" (node-identifier
 *                             [1*key-predicate / leaf-list-predicate / pos]))
 *   key-predicate       = "[" *WSP node-identifier *WSP "=" *WSP quoted-string *WSP "]"
 *   leaf-list-predicate = "[" *WSP "." *WSP "=" *WSP quoted-string *WSP "]"
 *   pos                 = "[" *WSP positive-integer-value *WSP "]"
 *
 * In XML every name carries a namespace prefix. In JSON the first name
 * carries its module name, and later names only where the module changes.
 * We accept an unprefixed XML name as being in the previous step's module.
 */

import type { CompiledModule, LeafNode, SchemaNode } from '../schema/model.js';
import { dataChildren } from '../schema/schema.js';
import { formatJson, formatText, parseText, scalarText, type PrefixWriter, type ValueScope } from './lexical.js';
import type { InstanceIdentifier, InstanceIdentifierStep, TypedValue } from './value.js';

const NAME = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const DATA_KINDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);

/** Parses an instance-identifier and resolves every step against the schema. Returns it, or a message. */
export function parseInstanceIdentifier(text: string, scope: ValueScope): InstanceIdentifier | string {
  let pos = 0;
  const ws = (): void => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  };
  const name = (): string | undefined => {
    NAME.lastIndex = pos;
    const m = NAME.exec(text);
    if (m === null) return undefined;
    pos = NAME.lastIndex;
    return m[0];
  };
  /** A node-identifier: `[prefix ":"] name`. */
  const nodeId = (): { prefix?: string; name: string } | undefined => {
    const first = name();
    if (first === undefined) return undefined;
    if (text[pos] !== ':') return { name: first };
    pos++;
    const second = name();
    return second === undefined ? undefined : { prefix: first, name: second };
  };
  const quoted = (): string | undefined => {
    const q = text[pos];
    if (q !== "'" && q !== '"') return undefined;
    const end = text.indexOf(q, pos + 1);
    if (end === -1) return undefined;
    const s = text.slice(pos + 1, end);
    pos = end + 1;
    return s;
  };
  const moduleOf = (prefix: string | undefined, inherited: CompiledModule | undefined): CompiledModule | string => {
    if (prefix === undefined) {
      const m = inherited ?? (scope.format === 'xml' ? scope.unprefixed : undefined);
      return m ?? `the first node name in '${text}' has no ${scope.format === 'json' ? 'module name' : 'prefix'}`;
    }
    return scope.module(prefix) ?? `'${prefix}' in '${text}' is not ${scope.format === 'json' ? 'a known module' : 'a namespace prefix of a known module'}`;
  };

  ws();
  if (text[pos] !== '/') return `'${text}' is not an instance identifier: it must start with '/'`;
  const steps: InstanceIdentifierStep[] = [];
  let candidates: SchemaNode[] = scope.schema.dataNodes.flatMap((n) => (DATA_KINDS.has(n.kind) ? [n] : dataChildren(n)));
  let module: CompiledModule | undefined;
  while (pos < text.length) {
    ws();
    if (pos >= text.length) break;
    if (text[pos] !== '/') return `unexpected '${text[pos]!}' at offset ${pos} in '${text}'`;
    pos++;
    const id = nodeId();
    if (id === undefined) return `a node name is missing at offset ${pos} in '${text}'`;
    const m = moduleOf(id.prefix, module);
    if (typeof m === 'string') return m;
    module = m;
    const node = candidates.find((c) => c.name === id.name && c.module === m && DATA_KINDS.has(c.kind));
    if (node === undefined) return `'${text}' names ${m.name}:${id.name}, which is not a data node here`;

    const step: { node: SchemaNode; keys?: { key: LeafNode; value: TypedValue }[]; value?: TypedValue; position?: number } = { node };
    while (text[pos] === '[') {
      pos++;
      ws();
      if (/[0-9]/.test(text[pos] ?? '')) {
        const start = pos;
        while (/[0-9]/.test(text[pos] ?? '')) pos++;
        if (node.kind !== 'list' && node.kind !== 'leaf-list') return `a position predicate in '${text}' is on ${node.name}, which is not a list or leaf-list`;
        step.position = Number(text.slice(start, pos));
        if (step.position < 1) return `positions in '${text}' start at 1`;
      } else if (text[pos] === '.') {
        pos++;
        ws();
        if (text[pos] !== '=') return `'=' is missing at offset ${pos} in '${text}'`;
        pos++;
        ws();
        const q = quoted();
        if (q === undefined) return `a quoted value is missing at offset ${pos} in '${text}'`;
        if (node.kind !== 'leaf-list') return `a value predicate in '${text}' is on ${node.name}, which is not a leaf-list`;
        const v = parseText((node).type, q, scope);
        if (typeof v === 'string') return `in '${text}': ${v}`;
        step.value = v;
      } else {
        const k = nodeId();
        if (k === undefined) return `a key name is missing at offset ${pos} in '${text}'`;
        ws();
        if (text[pos] !== '=') return `'=' is missing at offset ${pos} in '${text}'`;
        pos++;
        ws();
        const q = quoted();
        if (q === undefined) return `a quoted value is missing at offset ${pos} in '${text}'`;
        if (node.kind !== 'list') return `a key predicate in '${text}' is on ${node.name}, which is not a list`;
        const km = k.prefix === undefined ? m : scope.module(k.prefix);
        const key = (node).keys.find((x) => x.name === k.name && x.module === km);
        if (key === undefined) return `'${k.name}' in '${text}' is not a key of ${node.name}`;
        if (step.keys?.some((x) => x.key === key) === true) return `key '${k.name}' appears twice in '${text}'`;
        const keyScope: ValueScope = scope.format === 'json' ? { ...scope, unprefixed: key.module, module: scope.module.bind(scope) } : scope;
        const v = parseText(key.type, q, keyScope);
        if (typeof v === 'string') return `in '${text}': ${v}`;
        (step.keys ??= []).push({ key, value: v });
      }
      ws();
      if (text[pos] !== ']') return `']' is missing at offset ${pos} in '${text}'`;
      pos++;
    }
    steps.push(step);
    candidates = dataChildren(node);
  }
  if (steps.length === 0) return `'${text}' names no node`;
  return { steps };
}

/** Formats an instance-identifier: with namespace prefixes for XML, or module names for JSON. */
export function formatInstanceIdentifier(id: InstanceIdentifier, how: { json: true } | { prefix: PrefixWriter }): string {
  let out = '';
  let previous: CompiledModule | undefined;
  const qualify = (module: CompiledModule, context: CompiledModule | undefined): string => {
    if ('prefix' in how) return `${how.prefix(module)}:`;
    return module === context ? '' : `${module.name}:`;
  };
  const literal = (v: TypedValue): string => {
    const s = 'prefix' in how ? formatText(v, how.prefix) : scalarText(formatJson(v));
    return s.includes("'") ? `"${s}"` : `'${s}'`;
  };
  for (const step of id.steps) {
    out += `/${qualify(step.node.module, previous)}${step.node.name}`;
    for (const k of step.keys ?? []) out += `[${qualify(k.key.module, step.node.module)}${k.key.name}=${literal(k.value)}]`;
    if (step.value !== undefined) out += `[.=${literal(step.value)}]`;
    if (step.position !== undefined) out += `[${step.position}]`;
    previous = step.node.module;
  }
  return out;
}
