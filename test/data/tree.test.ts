import { beforeAll, describe, expect, it } from 'vitest';
import {
  ContainerInstance,
  DataTree,
  LeafInstance,
  LeafListEntry,
  ListEntry,
  OperationInstance,
  type ContainerNode,
  type LeafListNode,
  type LeafNode,
  type ListNode,
  type RpcNode,
  type Schema,
} from '../../src/index.js';
import { exSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
});

const str = (s: string): { type: LeafNode['type']; value: string } => ({ type: (schema.find('/ex:c/s') as LeafNode).type, value: s });

describe('instance tree', () => {
  it('keeps children in schema order, list keys first, whatever the insertion order', () => {
    const tree = new DataTree(schema);
    const c = tree.append(new ContainerInstance(schema.find('/ex:c') as ContainerNode));
    const entry = c.append(new ListEntry(schema.find('/ex:c/l') as ListNode));
    entry.append(new LeafInstance(schema.find('/ex:c/l/v') as LeafNode, str('v')));
    entry.append(new LeafInstance(schema.find('/ex:c/l/k2') as LeafNode, { type: (schema.find('/ex:c/l/k2') as LeafNode).type, value: 7 }));
    entry.append(new LeafInstance(schema.find('/ex:c/l/k1') as LeafNode, str('a')));
    c.append(new LeafInstance(schema.find('/ex:c/s') as LeafNode, str('first in schema')));
    const ll = schema.find('/ex:c/lls') as LeafListNode;
    c.append(new LeafListEntry(ll, str('x')));
    c.append(new LeafListEntry(ll, str('y')));

    expect(entry.children.map((n) => n.schema.name)).toEqual(['k1', 'k2', 'v']);
    expect(c.children.map((n) => n.schema.name)).toEqual(['s', 'lls', 'lls', 'l']);
    expect(c.childrenNamed('lls').map((n) => (n as LeafListEntry).value.value)).toEqual(['x', 'y']);
    expect(entry.path).toBe("/ex:c/l[k1='a'][k2='7']");
    expect(entry.child('v')!.path).toBe("/ex:c/l[k1='a'][k2='7']/v");
    expect(c.children[2]!.path).toBe("/ex:c/lls[.='y']");
    expect([...tree.walk()].length).toBe(8);
  });

  it('qualifies path steps where the module changes', () => {
    const tree = new DataTree(schema);
    const c = tree.append(new ContainerInstance(schema.find('/ex:c') as ContainerNode));
    const more = c.append(new ContainerInstance(schema.find('/ex:c/ex-aug:more') as ContainerNode));
    expect(more.path).toBe('/ex:c/ex-aug:more');
  });

  it('moves a node that is appended elsewhere, and finds the operation', () => {
    const tree = new DataTree(schema, 'rpc');
    const r = schema.module('ex')!.rpcs[0] as RpcNode;
    const op = tree.append(new OperationInstance(r, 'input'));
    const a = op.append(new LeafInstance(schema.find('/ex:r/a') as LeafNode, str('x')));
    op.append(new LeafInstance(schema.find('/ex:r/b') as LeafNode, { type: (schema.find('/ex:r/b') as LeafNode).type, value: 5n }));
    expect(op.children.map((n) => n.schema.name)).toEqual(['b', 'a']);
    expect(tree.operation).toBe(op);
    expect(a.path).toBe('/ex:r/a');
    const other = new DataTree(schema, 'rpc').append(new OperationInstance(r, 'input'));
    other.append(a);
    expect(op.children.map((n) => n.schema.name)).toEqual(['b']);
    expect(a.parent).toBe(other);
  });
});
