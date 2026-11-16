import { describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, toJson, toXml, treeDiagram, YangDataError, type ContainerNode, type DataIssue } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const BOOK = mod(
  'book',
  `sx:structure address-book {
    typedef nick { type string { length "1..8"; } }
    list address {
      leaf last { type string; }
      leaf first { type nick; }
      leaf street { type string; }
      leaf friend { type leafref { path "/book:address/book:first"; } }
    }
  }
  rc:yang-data problem {
    container problem {
      leaf code { type uint16; }
      leaf where { config false; type string; }
    }
  }
  container settings { leaf x { type string; } }`,
  '  import ietf-yang-structure-ext { prefix sx; }\n  import ietf-restconf { prefix rc; }',
);
const EXTRA = mod(
  'extra',
  `sx:augment-structure "/book:address-book/book:address" {
    leaf phone { type string; }
  }`,
  '  import ietf-yang-structure-ext { prefix sx; }\n  import book { prefix book; }',
);

function issues(fn: () => unknown): DataIssue[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof YangDataError) return [...err.issues];
    throw err;
  }
  throw new Error('expected a YangDataError');
}

describe('YANG data structures (RFC 8791, RFC 8040 §8)', () => {
  it('compile sx:structure as a container named after it, and rc:yang-data as its container', async () => {
    const schema = await compile([BOOK, EXTRA], { implement: ['book', 'extra'] });
    expect(schema.errors).toEqual([]);
    const book = schema.structure('book:address-book')!;
    expect(book).toMatchObject({ extension: 'structure', name: 'address-book' });
    const container = book.nodes[0] as ContainerNode;
    expect(container).toMatchObject({ kind: 'container', name: 'address-book', module: { name: 'book' } });
    // A list without a key is fine in a structure; the augment from another module joined it.
    const address = container.children[0]!;
    expect(address.children.map((c) => `${c.module.name}:${c.name}`)).toEqual(['book:last', 'book:first', 'book:street', 'book:friend', 'extra:phone']);
    expect(schema.structure('book:problem')!.nodes.map((n) => n.name)).toEqual(['problem']);
    // Structures aren't datastore content.
    expect(schema.dataNodes.map((n) => n.name)).toEqual(['settings']);
    expect(schema.structures.map((s) => s.name)).toEqual(['address-book', 'problem']);
  });

  it('read and write structure instances in both codecs', async () => {
    const schema = await compile([BOOK, EXTRA], { implement: ['book', 'extra'] });
    const xml =
      '<address-book xmlns="urn:book"><address><last>Ng</last><first>Al</first><phone xmlns="urn:extra">1</phone></address><address><first>Bo</first><friend>Al</friend></address></address-book>';
    const tree = decodeXml(schema, xml, { type: 'structure' });
    expect(tree.kind).toBe('structure');
    expect(toXml(tree)).toBe(xml);
    const json = toJson(tree);
    expect(json).toBe('{"book:address-book":{"address":[{"last":"Ng","first":"Al","extra:phone":"1"},{"first":"Bo","friend":"Al"}]}}');
    expect(toXml(decodeJson(schema, json, { type: 'structure', structure: 'book:address-book' }))).toBe(xml);
    // yang-data: the container is the top node, and config doesn't apply.
    expect(toJson(decodeXml(schema, '<problem xmlns="urn:book"><code>4</code><where>here</where></problem>', { type: 'structure' }))).toBe(
      '{"book:problem":{"code":4,"where":"here"}}',
    );
    // Types from a typedef inside the structure are checked.
    expect(issues(() => decodeXml(schema, '<address-book xmlns="urn:book"><address><first>far-too-long</first></address></address-book>', { type: 'structure' }))).toMatchObject([
      { code: 'invalid-value', path: '/book:address-book/address/first' },
    ]);
  });

  it('keep structures and datastore content apart', async () => {
    const schema = await compile([BOOK]);
    expect(issues(() => decodeXml(schema, '<address-book xmlns="urn:book"/>'))).toMatchObject([{ code: 'unknown-node' }]);
    expect(issues(() => decodeXml(schema, '<settings xmlns="urn:book"/>', { type: 'structure' }))).toMatchObject([{ code: 'unknown-node' }]);
    expect(issues(() => decodeXml(schema, '<problem xmlns="urn:book"/>', { type: 'structure', structure: 'book:address-book' }))).toMatchObject([{ code: 'unknown-node' }]);
    expect(issues(() => decodeJson(schema, {}, { type: 'structure', structure: 'book:nope' }))).toMatchObject([{ code: 'invalid-structure' }]);
    expect(issues(() => decodeJson(schema, {}, { structure: 'book:address-book' }))).toMatchObject([{ code: 'invalid-structure' }]);
  });

  it('print structures, yang-data and augment-structure in tree diagrams (RFC 8791 §2.3)', async () => {
    const schema = await compile([BOOK, EXTRA], { implement: ['book', 'extra'] });
    expect(treeDiagram(schema, { modules: ['book'] })).toBe(`module: book
  +--rw settings
     +--rw x?   string

  yang-data problem:
    +-- problem
       +-- code?    uint16
       +--ro where?   string

  structure address-book:
    +-- address* []
       +-- last?          string
       +-- first?         nick
       +-- street?        string
       +-- friend?        -> /address/first
       +-- extra:phone?   string
`);
    expect(treeDiagram(schema, { modules: ['extra'] })).toBe('module: extra\n\n  augment-structure /book:address-book/book:address:\n    +-- phone?   string\n');
    expect(treeDiagram(schema, { modules: ['book'], structures: false })).toBe('module: book\n  +--rw settings\n     +--rw x?   string\n');
  });
});
