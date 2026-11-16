/**
 * Filtering instance trees for reads (VALIDATE-09): RFC 6241 §6 subtree
 * filters, XPath selections (§8.9) and get-data pruning (RFC 8526 §3.1.1).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeXml,
  encodeJson,
  evaluateXPath,
  parseXml,
  pruneTree,
  selectionTree,
  subtreeFilter,
  toXml,
  DataTree,
  ListEntry,
  ContainerInstance,
  LeafInstance,
  type InstanceNode,
  type Schema,
  type XmlChild,
} from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

const T = mod(
  't',
  `
  import ietf-yang-metadata { prefix md; }
  md:annotation tag { type string; }
  md:annotation rank { type uint8; }
  identity iftype;
  identity ethernet { base iftype; }
  identity loopback { base iftype; }
  container top {
    container users {
      list user {
        key name;
        leaf name { type string; }
        leaf type { type string; }
        leaf full-name { type string; }
        container company-info {
          leaf dept { type uint8; }
          leaf id { type uint32; }
        }
      }
    }
    container interfaces {
      list interface {
        key name;
        leaf name { type string; }
        leaf mtu { type uint16; }
        leaf type { type identityref { base iftype; } }
        leaf-list address { type string; }
        container counters {
          config false;
          leaf in { type uint64; }
          leaf out { type uint64; }
        }
      }
    }
    container empty-here { presence "p"; }
    anydata blob;
  }
  container other { leaf name { type string; } }
`,
);

const O = mod('o', `import t { prefix t; } augment /t:top { leaf name { type string; } }`);

const DATA = `
<top xmlns="urn:t" xmlns:t="urn:t">
  <users>
    <user><name>root</name><type>superuser</type><full-name>Charlie Root</full-name>
      <company-info><dept>1</dept><id>1</id></company-info></user>
    <user t:tag="ops"><name>fred</name><type>admin</type><full-name>Fred Flintstone</full-name>
      <company-info><dept>2</dept><id>2</id></company-info></user>
    <user t:rank="7"><name>barney</name><type>admin</type><full-name>Barney Rubble</full-name>
      <company-info><dept>2</dept><id>3</id></company-info></user>
  </users>
  <interfaces>
    <interface><name>eth0</name><mtu>1500</mtu><type>t:ethernet</type>
      <address>10.0.0.1</address><address>10.0.0.2</address>
      <counters><in>10</in><out>20</out></counters></interface>
    <interface><name>lo</name><mtu>65535</mtu><type>t:loopback</type>
      <counters><in>1</in><out>1</out></counters></interface>
  </interfaces>
  <blob><anything xmlns="urn:x">hello</anything></blob>
  <name xmlns="urn:o">augmented</name>
</top>
<other xmlns="urn:t"><name>else</name></other>`;

let schema: Schema;
let tree: DataTree;

beforeAll(async () => {
  schema = await compile([T, O], { implement: ['t', 'o'] });
  expect(schema.errors).toEqual([]);
  tree = decodeXml(schema, DATA);
});

/** The children of a `<filter>` element written around `xml`. */
function f(xml: string): XmlChild[] {
  return [...(parseXml(`<filter xmlns="${NC}">${xml}</filter>`)[0]!.children ?? [])];
}

/** Annotations ('@' members) are dropped, except where a test asks for them: the data has some on the users. */
function bare(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(bare);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '@').map(([k, x]) => [k, bare(x)]));
}
const json = (t: DataTree): unknown => bare(encodeJson(t));
const filtered = (xml: string): unknown => json(subtreeFilter(tree, f(xml)));

describe('VALIDATE-09: filter a data tree as a NETCONF read does', () => {
  it('AC1: containment narrows, selection selects whole subtrees, content match tests values; the input is unchanged', () => {
    const before = toXml(tree);
    expect(filtered('<top xmlns="urn:t"><users><user><name>fred</name><company-info/></user></users></top>')).toEqual({
      't:top': { users: { user: [{ name: 'fred', 'company-info': { dept: 2, id: 2 } }] } },
    });
    // A selection node returns the whole subtree.
    expect(filtered('<other xmlns="urn:t"/>')).toEqual({ 't:other': { name: 'else' } });
    expect(toXml(tree)).toBe(before);
  });

  it('AC2: every content match among siblings must hold; only content matches return the whole entry', () => {
    // Two content matches, both true: the whole entry (RFC 6241 §6.4.6).
    expect(filtered('<top xmlns="urn:t"><users><user><name>fred</name><type>admin</type></user></users></top>')).toEqual({
      't:top': { users: { user: [{ name: 'fred', type: 'admin', 'full-name': 'Fred Flintstone', 'company-info': { dept: 2, id: 2 } }] } },
    });
    // One false: nothing.
    expect(filtered('<top xmlns="urn:t"><users><user><name>fred</name><type>superuser</type></user></users></top>')).toEqual({});
    // A content match with a selection: the match and the selection (§6.4.5).
    expect(filtered('<top xmlns="urn:t"><users><user><type>admin</type><full-name/></user></users></top>')).toEqual({
      't:top': {
        users: {
          user: [
            { name: 'fred', type: 'admin', 'full-name': 'Fred Flintstone' },
            { name: 'barney', type: 'admin', 'full-name': 'Barney Rubble' },
          ],
        },
      },
    });
    // A content match inside a containment node narrows only that node: the
    // name selection beside it still applies to every entry, as libyang does.
    expect(filtered('<top xmlns="urn:t"><users><user><name/><company-info><dept>2</dept></company-info></user></users></top>')).toEqual({
      't:top': { users: { user: [{ name: 'root' }, { name: 'fred', 'company-info': { dept: 2, id: 2 } }, { name: 'barney', 'company-info': { dept: 2, id: 3 } }] } },
    });
  });

  it('AC3: content matches compare typed values, with identityref prefixes from the filter', () => {
    expect(filtered('<top xmlns="urn:t"><interfaces><interface><mtu>01500</mtu><name/></interface></interfaces></top>')).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', mtu: 1500 }] } },
    });
    expect(filtered('<top xmlns="urn:t"><interfaces><interface><mtu> 1500 </mtu><name/></interface></interfaces></top>')).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', mtu: 1500 }] } },
    });
    // The filter's own prefix for the module, not the data's.
    expect(filtered('<top xmlns="urn:t" xmlns:x="urn:t"><interfaces><interface><type>x:loopback</type><name/></interface></interfaces></top>')).toEqual({
      't:top': { interfaces: { interface: [{ name: 'lo', type: 't:loopback' }] } },
    });
    // Text that isn't a value of the type matches nothing.
    expect(filtered('<top xmlns="urn:t"><interfaces><interface><mtu>big</mtu></interface></interfaces></top>')).toEqual({});
    // Leaf-list content match selects the matching entry; selection selects all.
    expect(filtered('<top xmlns="urn:t"><interfaces><interface><address>10.0.0.2</address><name/></interface></interfaces></top>')).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', address: ['10.0.0.2'] }] } },
    });
    expect(filtered('<top xmlns="urn:t"><interfaces><interface><address/></interface></interfaces></top>')).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', address: ['10.0.0.1', '10.0.0.2'] }] } },
    });
  });

  it('AC4: the empty namespace matches any module; an unknown namespace matches nothing', () => {
    expect(filtered('<top xmlns="urn:t"><name xmlns=""/></top>')).toEqual({ 't:top': { 'o:name': 'augmented' } });
    expect(filtered('<top xmlns="urn:t"><name xmlns="urn:o"/></top>')).toEqual({ 't:top': { 'o:name': 'augmented' } });
    expect(filtered('<top xmlns=""><name/></top>')).toEqual({ 't:top': { 'o:name': 'augmented' } });
    // Unqualified at the top, with no namespace option: the wildcard, both 'name' leaves under any top-level node.
    expect(json(subtreeFilter(tree, [{ name: 'other', children: [] }]))).toEqual({ 't:other': { name: 'else' } });
    expect(filtered('<top xmlns="urn:nope"/>')).toEqual({});
    // Elements inheriting the NETCONF namespace from <filter> match nothing.
    expect(filtered('<top/>')).toEqual({});
  });

  it('AC5: attribute matches compare with annotations by namespace, name and value', () => {
    const users = (attr: string): unknown => encodeJson(subtreeFilter(tree, f(`<top xmlns="urn:t" xmlns:t="urn:t"><users><user ${attr}><name/></user></users></top>`)));
    expect(users('t:tag="ops"')).toEqual({ 't:top': { users: { user: [{ '@': { 't:tag': 'ops' }, name: 'fred' }] } } });
    expect(users('t:tag="dev"')).toEqual({});
    // Typed annotations compare by value.
    expect(users('t:rank="007"')).toEqual({ 't:top': { users: { user: [{ '@': { 't:rank': 7 }, name: 'barney' }] } } });
    // Unqualified attribute: the annotation must be unqualified too.
    expect(users('tag="ops"')).toEqual({});
  });

  it('AC6: returned list entries keep their keys, and overlapping filter elements return the union', () => {
    expect(filtered('<top xmlns="urn:t"><users><user><full-name/></user></users></top>')).toEqual({
      't:top': {
        users: {
          user: [
            { name: 'root', 'full-name': 'Charlie Root' },
            { name: 'fred', 'full-name': 'Fred Flintstone' },
            { name: 'barney', 'full-name': 'Barney Rubble' },
          ],
        },
      },
    });
    const union = filtered(
      '<top xmlns="urn:t"><users>' +
        '<user><name>fred</name><type/></user>' +
        '<user><name>fred</name><company-info><id/></company-info></user>' +
        '<user><name>root</name><type/></user>' +
        '</users></top>',
    );
    expect(union).toEqual({
      't:top': { users: { user: [{ name: 'root', type: 'superuser' }, { name: 'fred', type: 'admin', 'company-info': { id: 2 } }] } },
    });
  });

  it('AC7: an empty filter returns nothing; unknown names select nothing without an error', () => {
    expect(json(subtreeFilter(tree, []))).toEqual({});
    expect(json(subtreeFilter(tree, ['  ']))).toEqual({});
    expect(filtered('<top xmlns="urn:t"><nope/></top>')).toEqual({});
    expect(filtered('<top xmlns="urn:t"><users><user><nope/></user></users></top>')).toEqual({});
    // A containment node whose children select nothing is left out, as is an empty presence container's selection of nothing.
    expect(filtered('<top xmlns="urn:t"><empty-here/></top>')).toEqual({});
    // Containment on a leaf matches nothing; anydata is selected whole.
    expect(filtered('<top xmlns="urn:t"><users><user><name><x/></name></user></users></top>')).toEqual({});
    expect(filtered('<top xmlns="urn:t"><blob><anything xmlns="urn:x"/></blob></top>')).toEqual({
      't:top': { blob: { anything: 'hello' } },
    });
  });

  it('AC8: an XPath node-set becomes a tree of the nodes with their subtrees, ancestors and keys', () => {
    const nodes = evaluateXPath(tree, "/t:top/t:users/t:user[t:type='admin']/t:company-info") as InstanceNode[];
    expect(json(selectionTree(tree, nodes))).toEqual({
      't:top': { users: { user: [{ name: 'fred', 'company-info': { dept: 2, id: 2 } }, { name: 'barney', 'company-info': { dept: 2, id: 3 } }] } },
    });
    expect(json(selectionTree(tree, evaluateXPath(tree, '/') as (InstanceNode | DataTree)[]))).toEqual(json(tree));
    expect(json(selectionTree(tree, []))).toEqual({});
  });

  it('AC9: pruning by depth, to configuration, or to state, and combined', () => {
    expect(json(pruneTree(tree, { maxDepth: 1 }))).toEqual({ 't:top': {}, 't:other': {} });
    expect(json(pruneTree(tree, { maxDepth: 3 }))).toMatchObject({
      't:top': { users: { user: [{ name: 'root' }, { name: 'fred' }, { name: 'barney' }] } },
    });
    const users3 = (encodeJson(pruneTree(tree, { maxDepth: 3 })) as { 't:top': { users: { user: object[] } } })['t:top'].users.user;
    expect(users3[0]).toEqual({ name: 'root' });
    const config = encodeJson(pruneTree(tree, { config: true })) as { 't:top': { interfaces: { interface: Record<string, unknown>[] } } };
    expect(config['t:top'].interfaces.interface[0]).not.toHaveProperty('counters');
    expect(json(pruneTree(tree, { config: false }))).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', counters: { in: '10', out: '20' } }, { name: 'lo', counters: { in: '1', out: '1' } }] } },
    });
    // State at depth 4 is cut by maxDepth 3.
    expect(json(pruneTree(tree, { config: false, maxDepth: 3 }))).toEqual({});
    expect(json(pruneTree(tree, { config: false, maxDepth: 4 }))).toEqual({
      't:top': { interfaces: { interface: [{ name: 'eth0', counters: {} }, { name: 'lo', counters: {} }] } },
    });
    expect(() => pruneTree(tree, { maxDepth: 0 })).toThrow(RangeError);
  });

  it('AC9: pruning with a keep callback: keep, drop and descend, keys never asked, other options still apply', () => {
    const asked: string[] = [];
    const keep = (n: InstanceNode): 'keep' | 'drop' | 'descend' => {
      asked.push(n.path);
      if (n.schema.name === 'other') return 'drop';
      if (n.schema.name === 'user') return (n as ListEntry).keys[0]!.value.value === 'fred' ? 'drop' : 'keep';
      if (n.schema.name === 'interfaces') return 'keep';
      return 'descend';
    };
    const pruned = json(pruneTree(tree, { keep }));
    expect(pruned).not.toHaveProperty('t:other');
    const users = (pruned as { 't:top': { users: { user: { name: string }[] } } })['t:top'].users.user;
    expect(users.map((u) => u.name)).toEqual(['root', 'barney']);
    expect((pruned as Record<string, { interfaces: unknown }>)['t:top']!.interfaces).toEqual((json(tree) as Record<string, { interfaces: unknown }>)['t:top']!.interfaces);
    // Nothing below a kept node is asked about, nor a list entry's keys.
    expect(asked.some((p) => p.includes('/interfaces/'))).toBe(false);
    expect(asked.some((p) => p.endsWith('/name'))).toBe(false);
    // Dropping everything leaves an empty tree; a descended node stays when its children are all dropped.
    expect(json(pruneTree(tree, { keep: () => 'drop' }))).toEqual({});
    expect(json(pruneTree(tree, { keep: (n) => (n.parent instanceof DataTree ? 'descend' : 'drop') }))).toEqual({ 't:top': {}, 't:other': {} });
    // maxDepth and config still apply.
    expect(json(pruneTree(tree, { keep: () => 'descend', maxDepth: 1 }))).toEqual({ 't:top': {}, 't:other': {} });
    expect(json(pruneTree(tree, { keep: () => 'descend', config: false }))).toEqual(json(pruneTree(tree, { config: false })));
    // The input is unchanged.
    expect(json(tree)).toHaveProperty('t:other');
  });

  it('AC10: filtering about 100,000 nodes takes well under a second', () => {
    const big = new DataTree(schema);
    const top = big.append(new ContainerInstance(schema.find('/t:top') as never));
    const users = top.append(new ContainerInstance(schema.find('/t:top/users') as never));
    const user = schema.find('/t:top/users/user') as never as ListEntry['schema'];
    const leaf = (path: string): LeafInstance['schema'] => schema.find(path) as never;
    const nameS = leaf('/t:top/users/user/name');
    const typeS = leaf('/t:top/users/user/type');
    const fullS = leaf('/t:top/users/user/full-name');
    const str = (s: LeafInstance['schema'], v: string): LeafInstance => new LeafInstance(s, { type: s.type, value: v });
    for (let i = 0; i < 25_000; i++) {
      const e = users.append(new ListEntry(user));
      e.append(str(nameS, `u${i}`));
      e.append(str(typeS, i % 100 === 0 ? 'admin' : 'user'));
      e.append(str(fullS, `User ${i}`));
    }
    const start = performance.now();
    const out = subtreeFilter(big, f('<top xmlns="urn:t"><users><user><type>admin</type><full-name/></user></users></top>'));
    const elapsed = performance.now() - start;
    expect((encodeJson(out) as { 't:top': { users: { user: unknown[] } } })['t:top'].users.user).toHaveLength(250);
    expect(elapsed).toBeLessThan(1000);
  });
});
