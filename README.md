# @node-net/yang

YANG for Node.js, written in TypeScript: a parser and compiler for YANG 1.0 and 1.1 modules (RFC 6020, RFC 7950), and codecs for YANG-modelled data in XML and JSON (RFC 7951).

> **Status: early development (0.0.x).** Milestones 1 to 6 are done: parsing YANG 1.0 and 1.1 modules (and YIN), compiling module sets into a resolved schema (imports, submodules, groupings, augments, deviations, features, identities, types, leafrefs), YANG data in XML and RFC 7951 JSON, schema queries for completion, schemas built from a server's YANG library per datastore, with-defaults, tree diagrams, instance-data files, YANG data structures, and validation with an XPath 1.0 engine (must, when, leafref and instance-identifier integrity, unique, element counts, mandatory nodes, choices), and an edit engine that applies NETCONF edits and diffs data trees. The planned scope and milestones are in [docs/rfcs.md](./docs/rfcs.md).

## Example: compile a module set

```ts
import { compileSchema, fileSource, builtinSource, chainSources } from '@node-net/yang';

const schema = await compileSchema({
  source: chainSources(fileSource(['./yang']), builtinSource),
  modules: ['ietf-interfaces', 'ietf-ip'],
  features: { 'ietf-interfaces': ['if-mib'] }, // modules not listed have every feature enabled
});
for (const d of schema.errors) console.error(d.message);

const mtu = schema.find('/ietf-interfaces:interfaces/interface/ietf-ip:ipv4/mtu');
// { kind: 'leaf', type: { builtin: 'uint16', range: [{ min: 68n, max: 65535n }] }, config: true, ... }
```

`builtinSource` holds the IETF modules nearly everything imports (common types, metadata, YANG library, instance data, NETCONF, RESTCONF, NACM). They are embedded in the library, so they need no filesystem, and loaded with `import()` the first time one is looked up, so a code-splitting bundler puts the text in a chunk of its own. Sources are pluggable: anything with a `load(name, revision?)` method works, which is how @node-net/netconf can supply modules fetched with `<get-schema>`. `memorySource()` takes module texts you already hold.

`@node-net/yang/core` is everything except `fileSource()`, and needs nothing from Node.js, so it runs in a browser, a worker or another JavaScript runtime. `@node-net/yang` is the same plus `fileSource()`.

A compiled schema doesn't keep the parsed statements it was compiled from, which roughly halves its memory (121 MB rather than 308 MB for the whole Nokia SR OS release). Tools that need them, such as a linter, pass `keepStatements: true` and find each one on `node.statement`. Extension uses always keep theirs.

## Example: convert XML to JSON and back

```ts
import { decodeXml, toJson, decodeJson, toXml, YangDataError } from '@node-net/yang';

const xml = `<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
  <interface>
    <name>eth0</name>
    <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:ethernetCsmacd</type>
    <ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip"><mtu>1500</mtu></ipv4>
  </interface>
</interfaces>`;

const tree = decodeXml(schema, xml); // schema from compileSchema, with iana-if-type too
console.log(toJson(tree, { indent: 2 }));
// {
//   "ietf-interfaces:interfaces": {
//     "interface": [
//       {
//         "name": "eth0",
//         "type": "iana-if-type:ethernetCsmacd",
//         "ietf-ip:ipv4": { "mtu": 1500 }
//       }
//     ]
//   }
// }

try {
  decodeJson(schema, { 'ietf-interfaces:interfaces': { interface: [{ name: 'eth0', 'ietf-ip:ipv4': { mtu: '1500' } }] } });
} catch (err) {
  if (err instanceof YangDataError) for (const i of err.issues) console.log(i.code, i.path, i.message);
  // invalid-value /ietf-interfaces:interfaces/interface[name='eth0']/ietf-ip:ipv4/mtu
  //   '1500' is not a JSON number, as uint16 requires (RFC 7951 §6.1)
}
```

The tree in between (`DataTree`) holds typed values (`bigint` for 64-bit integers, `Decimal64`, identity objects) and links every node to its schema node. Attributes such as NETCONF's `nc:operation` are carried as annotations. `decodeXml` also takes already-parsed elements, such as @node-net/netconf's `XmlElement`, and RPCs, actions, replies and notifications with the `type` option. The `operation` option reads bare parameters or a notification's bare content, given the operation's path: `decodeJson(schema, { reason: 'x' }, { type: 'notification', operation: "/ex:servers/server[name='a']/restarted" })` builds the keyed ancestors of a nested notification. `xmlToJson` and `jsonToXml` do a conversion in one call. Invalid data throws a `YangDataError` listing every problem with its data path. With `positions: true`, issues from text input also carry a `position` (line and column in the text), and so do issues from validating the tree later.

## Example: schema queries for completion

```ts
schema.complete('/ietf-interfaces:interfaces/interface[name="eth0"]/ietf-ip:ipv4/m');
// [{ text: '/ietf-interfaces:interfaces/interface[name="eth0"]/ietf-ip:ipv4/mtu', kind: 'node', node: { ... } }]

schema.describe('/if:interfaces/interface/ip:ipv4/mtu');
// { kind: 'leaf', config: true, units: 'octets', type: { text: 'uint16 (68..65535)', ... }, description: '...' }

schema.children('/interfaces/interface')?.map((n) => n.name);
// ['name', 'description', 'type', 'enabled', ..., 'ipv4', 'ipv6']
```

Paths are read tolerantly, as people type them: module names or YANG prefixes or none, with list predicates skipped.

## Example: the schemas a server reports

```ts
import { builtinSource, chainSources, compileYangLibrary, decodeXml, decodeYangLibrary, fileSource, YangDataError } from '@node-net/yang';

// The <yang-library> element from a <get> (RFC 8525), or RFC 7895 modules-state.
const library = await decodeYangLibrary(yangLibraryXml);
const source = chainSources(fileSource(['./yang']), builtinSource); // module text, as in the first example
const schemas = await compileYangLibrary(library, { source }); // exact revisions, features and deviations
const running = schemas.datastore('running');
running.datastore; // 'ietf-datastores:running'
running.holdsState; // false: a configuration datastore

try {
  decodeXml(running, '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface><name>eth0</name><oper-status>up</oper-status></interface></interfaces>');
} catch (err) {
  if (err instanceof YangDataError) for (const i of err.issues) console.log(i.code, i.path);
  // state-data /ietf-interfaces:interfaces/interface[name='eth0']/oper-status
}
```

Each module set is compiled once and shared by the datastores that use it. `schemas.datastore('operational')` accepts state data and the `ietf-origin` annotation. For servers without the library, `fromCapabilities(helloCapabilities)` builds the same description from YANG 1.0 module capabilities, and `readYangLibrary` takes the data as RFC 7951 JSON or a decoded tree. Module text still comes from a source, such as one backed by `<get-schema>`.

## Example: with-defaults

```ts
import { applyWithDefaults, toXml, toJson } from '@node-net/yang';

const tree = decodeXml(running, `<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
  <interface><name>eth0</name><type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:ethernetCsmacd</type></interface>
</interfaces>`);
applyWithDefaults(tree, 'report-all-tagged'); // or 'report-all', 'trim', 'explicit' (RFC 6243)
console.log(toXml(tree, { indent: 2 }));
// <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
//   <interface>
//     <name>eth0</name>
//     <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:ethernetCsmacd</type>
//     <enabled xmlns:wd="urn:ietf:params:xml:ns:netconf:default:1.0" wd:default="true">true</enabled>
//   </interface>
// </interfaces>
console.log(toJson(tree));
// {"ietf-interfaces:interfaces":{"interface":[{"name":"eth0","type":"iana-if-type:ethernetCsmacd",
//   "enabled":true,"@enabled":{"ietf-netconf-with-defaults:default":true}}]}}
```

Both codecs read the `default` tag too, setting `isDefault` on the node.

## Example: validation

```ts
import { decodeJson, validate, YangDataError } from '@node-net/yang';

// schema from compileSchema, with ietf-interfaces, ietf-routing, ietf-ipv6-unicast-routing and iana-if-type
const running = schema.forDatastore('running');
const tree = decodeJson(running, {
  'ietf-interfaces:interfaces': { interface: [{ name: 'eth0', type: 'iana-if-type:ethernetCsmacd' }] },
  'ietf-routing:routing': {
    'control-plane-protocols': {
      'control-plane-protocol': [{
        type: 'ietf-routing:static', name: 'st0',
        'static-routes': { 'ietf-ipv6-unicast-routing:ipv6': { route: [{ 'destination-prefix': '::/0', 'next-hop': { 'outgoing-interface': 'eth1' } }] } },
      }],
    },
  },
});
for (const i of validate(tree)) console.log(i.severity, i.code, i.path, i.message);
// error missing-instance /ietf-routing:routing/control-plane-protocols/control-plane-protocol[type='ietf-routing:static'][name='st0']
//   /static-routes/ietf-ipv6-unicast-routing:ipv6/route[destination-prefix='::/0']/next-hop/outgoing-interface
//   leafref value 'eth1' matches no instance of /if:interfaces/if:interface/if:name

try {
  decodeJson(running, { 'ietf-interfaces:interfaces': { interface: [{ name: 'eth0' }] } }, { validate: true });
} catch (err) {
  if (err instanceof YangDataError) for (const i of err.issues) console.log(i.code, i.path);
  // missing-mandatory /ietf-interfaces:interfaces/interface[name='eth0']/type
}
```

`validate` checks `when`, `must` (with its `error-message` and `error-app-tag`), leafref and instance-identifier targets, `unique`, `min-elements` and `max-elements`, mandatory nodes and choices, data from more than one case, and repeated values in configuration leaf-lists. It returns every issue with its data path and the error-app-tag RFC 7950 §15 gives it, and leaves the tree as it was (defaults are added while it works, then removed; `keepDefaults` keeps them). `addDefaults` uses the same engine, so defaults guarded by `when` are added when the condition holds.

The checks follow the tree: an RPC, action, reply or notification is checked against datastore data passed as `operational` (an action must find its parent there), a structure is its own document, `<operational>` reports broken semantic constraints as warnings (RFC 8342 §5.3), and `partial: true` (the default for instance-data files) skips what partial data may lack.

## Example: edits and diffs

```ts
import { applyEdit, decodeJson, decodeXml, diffEdit, diffTrees, toXml, YangDataError } from '@node-net/yang';

// schema from compileSchema, with ietf-interfaces and iana-if-type
const running = schema.forDatastore('running');
const before = decodeJson(running, {
  'ietf-interfaces:interfaces': { interface: [
    { name: 'eth0', type: 'iana-if-type:ethernetCsmacd', enabled: true },
    { name: 'eth1', type: 'iana-if-type:ethernetCsmacd' },
  ] },
});
const edit = decodeXml(running, `
  <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces" xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0">
    <interface><name>eth0</name><enabled>false</enabled></interface>
    <interface nc:operation="delete"><name>eth1</name></interface>
    <interface nc:operation="create"><name>lo0</name>
      <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:softwareLoopback</type></interface>
  </interfaces>`, { edit: true });
const after = applyEdit(before, edit, { validate: true }); // before is unchanged

for (const c of diffTrees(before, after)) console.log(c.operation, c.path);
// delete /ietf-interfaces:interfaces/interface[name='eth1']
// create /ietf-interfaces:interfaces/interface[name='lo0']
// replace /ietf-interfaces:interfaces/interface[name='eth0']/enabled

console.log(toXml(diffEdit(after, before))); // the <edit-config> content that undoes it

try {
  applyEdit(after, edit);
} catch (err) {
  if (err instanceof YangDataError) for (const i of err.issues) console.log(i.code, i.path);
  // data-missing /ietf-interfaces:interfaces/interface[name='eth1']
  // data-exists /ietf-interfaces:interfaces/interface[name='lo0']
}
```

`applyEdit` applies the content of an `<edit-config>` or `<edit-data>` to a copy of a datastore's tree, as a server would: `merge`, `replace`, `create`, `delete` and `remove` (RFC 6241 §7.2), inherited from parent to child, with a `defaultOperation` of `merge`, `replace` or `none`. New entries of ordered-by-user lists and leaf-lists go where `yang:insert` says; creating a node in one case of a choice deletes the other cases. It reports every problem (`data-exists`, `data-missing`, `missing-anchor`, `multiple-cases`, `invalid-edit`) and applies nothing if there is one, and `validate` checks the result. `tryApplyEdit` takes `<edit-config>`'s other error options too: with `errorOption: 'stop-on-error'` it keeps what applied before the first error, and with `'continue-on-error'` it skips each part that fails and applies the rest. It returns `{ tree, errors, rejected }` rather than throwing, and a result that fails validation is rejected whatever the option. Read edits with the decoders' `edit` option, which checks the edit attributes. State data can't be edited, as NETCONF has it, unless a server editing the `<operational>` state it holds passes `state: true`; then state nodes are edited like configuration, and `replace` replaces them too.

`diffTrees` lists what changed between two trees, matching list entries by key and leaf-list entries by value, with moves of ordered-by-user entries kept to the fewest. `diffEdit` turns that into an edit that `applyEdit`, or a NETCONF server, applies to the first tree to get the second. In `<operational>`, diffs also report a change to a node's `or:origin` (RFC 8342), which children inherit, and edits keep at most one origin on each node; `effectiveOrigin(node)` reads it.

## Example: XPath

```ts
import { evaluateXPath } from '@node-net/yang';

// tree: interfaces eth0 (ethernetCsmacd, with IPv4 address 192.0.2.1/24) and lo0 (softwareLoopback)
evaluateXPath(tree, "/if:interfaces/if:interface[derived-from-or-self(if:type, 'ianaift:ethernetCsmacd')]/if:name").map((n) => n.path);
// [ "/ietf-interfaces:interfaces/interface[name='eth0']/name" ]
evaluateXPath(tree, 'count(//ip:address)'); // 1
evaluateXPath(tree, "/if:interfaces/if:interface[if:name = 'eth0']/ip:ipv4/ip:address/ip:prefix-length > 16"); // true
```

XPath 1.0 with YANG's functions (`current`, `re-match`, `deref`, `derived-from`, `derived-from-or-self`, `enum-value`, `bit-is-set`). Prefixes default to every module's name and YANG prefix; pass `prefixes`, `context` and `defaultModule` to evaluate as a module expression would be. `parseXPath` and `printXPath` give and take the syntax tree. The compiler parses every `must`, `when` and leafref `path` and reports syntax errors and unknown prefixes and functions as diagnostics.

## Example: filters for reads

```ts
import { parseXml, pruneTree, selectionTree, subtreeFilter, evaluateXPath, toXml, type InstanceNode } from '@node-net/yang';

// The children of a <filter type="subtree"> element, parsed.
const [filter] = parseXml(`<filter xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
    <interface><type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:ethernetCsmacd</type><name/></interface>
  </interfaces></filter>`);
toXml(subtreeFilter(tree, filter!.children ?? []));
// <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface><name>eth0</name><type ...>ianaift:ethernetCsmacd</type></interface></interfaces>

const nodes = evaluateXPath(tree, "//if:interface[if:enabled = 'false']") as InstanceNode[];
selectionTree(tree, nodes); // an :xpath filter's reply
pruneTree(tree, { maxDepth: 2, config: false }); // <get-data> max-depth and config-filter
```

`subtreeFilter` follows RFC 6241 §6: containment, selection and content-match nodes with the sibling rules of §6.2.5, attribute matches against annotations, and `xmlns=""` as a wildcard. Content matches compare typed values, so `01500` matches a uint16 `1500` and identityref prefixes are the filter's own. List entries come back with their keys, and overlapping filter elements return the union. `selectionTree` turns an XPath node-set into a reply tree (RFC 6241 §8.9), and `pruneTree` applies RFC 8526's `max-depth` and `config-filter`, plus an optional `keep(node)` callback answering `keep`, `drop` or `descend` for each node it visits (@node-net/netconf-server prunes reads to what NACM permits with it). All three return new trees and leave the input unchanged. To send a shared tree less some nodes without copying it, pass `encodeXml` or `toXml` a `skip(node)` option instead.

`mergeTrees(target, ...sources)` combines trees, configuration and state alike, as `<operational>` and `<get>` do (RFC 8342 §5.3): containers match by schema node, list entries by keys and leaf-list entries by value, and later sources win for leaf values and annotations. Sources may be decoded with another datastore's schema from the same compile.

## Example: tree diagrams

```ts
import { treeDiagram } from '@node-net/yang';

console.log(treeDiagram(running, { modules: ['ietf-interfaces'], lineLength: 69, depth: 3 }));
// module: ietf-interfaces
//   +--rw interfaces
//   |  +--rw interface* [name]
//   |     +--rw name               string
//   |     +--rw description?       string
//   |     +--rw type               identityref
//   |     +--rw enabled?           boolean
//   |     +--ro oper-status        enumeration
//   ...
//   |     +--rw ip:ipv4!
//   |     |     ...
```

The output is `pyang -f tree`'s, character for character (RFC 8340, with RFC 8791 structures).

## Example: instance-data files

```ts
import { writeInstanceData, readInstanceData } from '@node-net/yang';

const text = await writeInstanceData(tree, { name: 'eth0-snapshot', timestamp: '2026-11-09T02:00:00Z' }, { format: 'json', withDefaults: 'trim' });
// {"ietf-yang-instance-data:instance-data-set": {"name": "eth0-snapshot", "includes-defaults": "trim",
//   "content-schema": {"module": ["ietf-interfaces@2018-02-20", "ietf-ip@2018-02-22", "iana-if-type@2023-01-26"]},
//   "datastore": "ietf-datastores:running", "timestamp": "2026-11-09T02:00:00Z", "content-data": {...}}}

const file = await readInstanceData(text); // XML or JSON (RFC 9195)
file.header.contentSchema; // { kind: 'modules', modules: [{ name: 'ietf-interfaces', revision: '2018-02-20' }, ...] }
const data = file.decode(await file.compileSchema(source));
```

`compileSchema` builds the schema from the header's module list or inline YANG library. Data defined with `sx:structure` (RFC 8791) or `rc:yang-data` (RFC 8040) is read and written with `{ type: 'structure' }`, and YIN modules (RFC 7950 §13) load like YANG ones.

## Example: parse one file

```ts
import { readFileSync } from 'node:fs';
import { parseModule, formatLocation } from '@node-net/yang';

const { statement, yangVersion, diagnostics } = parseModule(readFileSync('ietf-interfaces.yang'), {
  source: 'ietf-interfaces.yang',
});
for (const d of diagnostics) console.log(`${formatLocation(d.location)}: ${d.severity}: ${d.message}`);
console.log(statement.keyword, statement.argument, yangVersion); // module ietf-interfaces 1.1
```

Unrecoverable syntax (an unterminated string, a missing `}`) throws a `YangSyntaxError` with the location. Everything else, from unknown statements to invalid arguments, is a diagnostic, and the statement tree is complete regardless.

`parseYin` reads YIN into the same statement tree, `writeYin` writes a tree as YIN, and `writeYang` writes one as YANG text, quoting each argument so it reads back unchanged (comments are not kept). Together they convert a module between YANG and YIN.

- **Pure TypeScript:** no native bindings, no Python or C toolchain, no runtime dependency on pyang or libyang.
- **Protocol-agnostic:** usable with NETCONF, RESTCONF, gNMI or offline. [@node-net/netconf](https://www.npmjs.com/package/@node-net/netconf) builds on it, never the other way round.
- **First goals, now met:** XML ↔ RFC 7951 JSON conversion, and schema queries for completion.

## Install

```sh
npm install @node-net/yang
```

Node.js 22.12 or later. The package is ESM, and CommonJS code can load it with `require()`.

## Development

```sh
npm install
npm run check
```

There is no CI for changes: what gates a change is these checks, run locally before it lands. Only releases run on GitHub (below).

- **`npm run check` runs before every landing:** lint, typecheck, tests, build, the CommonJS, portability and pack checks, and last the runtime audit. `npm audit --omit=dev` fails the check on any known vulnerability in the runtime dependencies. If the registry can't be reached, the audit is skipped with a loud warning and the check still passes, so it works offline. `NN_REQUIRE_AUDIT=1` makes that skip a failure.
- **`npm run check:full`** (`scripts/check-full.sh`) runs `check` with the audit required, then a typecheck with TypeScript 7.0.2, `scripts/check-node.sh 22 24 26` (Docker required), and the full `npm audit`, which is reported but never fails. `--quick` skips the Node.js lines, and `--only ts7,check` runs just the steps named. Run it before landing any change to dependencies or these scripts, and whenever unsure.
- **Every Node.js LTS line that `engines` allows must pass the whole check.** `scripts/check-node.sh` runs `npm install` and `npm run check` for each line in a clean `node:<line>` container, with a copy of the working tree. When a new line is promoted to LTS, add it to the script's default lines; when one reaches end of life, drop it and raise `engines`.
- **Updates:** `npm run deps:report` lists outdated dependencies, with in-range updates apart from those needing a range change, and summarises the runtime and full audits.
- **Releases:** `npm version patch` (or `minor`, `major`), then `git push --follow-tags`. The tag starts `.github/workflows/release.yml`, which runs `check` and publishes to npm through trusted publishing, so no npm token exists anywhere. Each version carries a provenance statement linking it to its commit.
- `scripts/install-hooks.sh` installs an opt-in git pre-push hook that runs `npm run check` (`--uninstall` removes it).
- The oracle scripts (`scripts/*-oracle.sh`) compare results with pyang, yanglint and sysrepo in Docker; the tests use their recorded output.
- [docs/](docs/) holds the maintainer notes: the [design](docs/net-yang-design.md), the [RFC survey](docs/rfcs.md) and the [backlog](docs/backlog.md).

## Licence

MIT
