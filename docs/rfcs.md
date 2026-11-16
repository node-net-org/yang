# YANG-related RFCs: survey and implementation scope for @node-net/yang

Survey date: 2026-11-08. The RFC list was extracted from the RFC Editor's `rfc-index.xml` (every RFC whose title, abstract or keywords mention YANG, up to RFC 10082), and draft status comes from the IETF datatracker. A few protocol RFCs that matter to YANG but don't name it in their abstract (6241, 6243, 10016) were added by hand.

The index gives **165 YANG-related RFCs**. They fall into three groups:

1. **Language and infrastructure** (about 30): the language itself, encodings, metadata, module discovery, file formats and guidelines. This is what @node-net/yang implements, or chooses not to.
2. **Protocols that carry YANG data** (about 20): NETCONF, RESTCONF, subscriptions, CORECONF. @node-net/yang stays protocol-agnostic, but its codecs must be what these protocols need.
3. **Data models** (114): "A YANG Data Model for X". @node-net/yang implements none of them specially. A correct compiler handles all of them, so they are the **test corpus**, not the scope. They're listed in the [appendix](#appendix-data-model-rfcs).

## Tiers

| Tier | Meaning |
|------|---------|
| **P0 – Core** | @node-net/yang is not a YANG library without it. Needed for the first two use cases: XML ↔ JSON conversion and nnc completion. |
| **P1 – Next** | Planned after the core: schema from a server's YANG library, validation, file formats, tree diagrams. |
| **P2 – Later** | Wanted eventually (CBOR, schema mount, linting, schema diff). The architecture must leave room for these. No code yet. |
| **P3 – Out of scope** | Recorded so the decision is explicit. |

## 1. The language

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| **7950** | The YANG 1.1 Data Modeling Language (2016; updated by 8342, 8526) | **P0** | The specification. §6 (lexical rules, strings, XPath contexts), §7 (every statement), §9 (built-in types), §14 (ABNF grammar). The substatement tables in §7 decide which statements may appear where and how often. They should be a **data table**, not code, so YANG 1.0 and 2.0 become different tables. §10 (XPath functions) is P1, with validation. |
| **6020** | YANG 1.0 (2010; updated by 9890) | **P0** | Many vendor models, Nokia's included, are still `yang-version 1`. Same parser. The change list in 7950 §1.1 drives version-gated rules: `action`, `anydata`, multiple identity bases, `if-feature` expressions, `if-feature` on enum/bit, leafref and empty in unions. |
| 9890 | An Update to YANG Module Names Registration (2025) | P3 | IANA registry policy only. No code. |
| 6095 | Extending YANG with Language Abstractions (Experimental) | P3 | Never adopted. |
| draft-ietf-netmod-yang2 | YANG 2.0 (rev 01, Oct 2026) | P2 (watch) | A major revision is in progress. Its consequence today: the grammar and substatement rules are versioned data, and `yang-version` picks the table. |

**Normative non-RFC dependencies.** These are as much work as any RFC:

- **XSD regular expressions** (W3C XML Schema 1.1 Part 2, cited by 7950 §9.4.5) for `pattern`. They are not JavaScript regexes: anchoring is implicit, `\i` `\c` and `\p{Is…}` block escapes exist, and character-class subtraction (`[a-z-[aeiou]]`) is allowed. We need an XSD → `RegExp` translator (with the `u` or `v` flag). **P0**: type checking and value encoding depend on it. Patterns are matched with a linear-time automaton built from the same parse, not with the translated `RegExp`, which can backtrack exponentially on values from devices (design §4.4, §7.4).
- **XPath 1.0** (W3C) for `must`, `when` and full `path`/instance-identifier evaluation. **P1.** For P0 we only need to *parse* leafref `path` (7950 §9.9.2 `path-arg`, a small XPath subset) to resolve its target type.
- **ABNF** (RFC 5234) only to read the 7950 §14 grammar. Nothing to implement.

## 2. Built-in modules and common types

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| **9911** | Common YANG Data Types (Dec 2025; obsoletes 6991, which obsoleted 6021) | **P0** | `ietf-yang-types` and `ietf-inet-types`. They are ordinary modules, so no special code is needed, but nearly every model imports them. **Bundle** them (with older revisions, which devices still reference) in a built-in module source, under the IETF Trust's Simplified BSD licence for code components. |
| **7952** | Defining and Using Metadata with YANG | **P0** | `md:annotation` (module `ietf-yang-metadata`). Annotations are XML attributes, and `@`-members in JSON (7951 §5.2.1). with-defaults tagging, NMDA `origin` and `nc:operation`-style attributes all travel this way, so the instance-data model must carry annotations from the start. |
| 8791 | YANG Data Structure Extensions | P1 | `sx:structure` and `sx:augment-structure`: YANG-defined data that isn't in any datastore. Needed to compile 9195, YANG Patch and others. |
| 8040 §8 (`rc:yang-data`) | The older version of the same idea, defined in RESTCONF | P1 | Same handling as 8791. Many published modules still use it. |
| 8819 | YANG Module Tags | P3 | Just a model. |
| 8199 | YANG Module Classification (Informational) | P3 | Terminology. |

**Extensions in general.** Unknown `extension` statements must be parsed, kept with their arguments, and exposed through the API, never rejected. Vendor models are full of them (Nokia, Cisco, Juniper, OpenConfig's `oc-ext:`). Known extensions (`md:annotation`, `sx:structure`, `rc:yang-data`, `nacm:default-deny-*`) get registered handlers. That handler registry is how later RFCs and drafts plug in without changes to the compiler.

## 3. Encodings of instance data

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| **7950 §7, §9** (XML encoding) | XML encoding rules, scattered through the statement and type sections | **P0** | Element-per-node, namespace = module namespace, list entries as repeated elements, keys first, `identityref` as a QName with an in-scope prefix, `instance-identifier` as an XPath with prefixes, `empty` as an empty element. |
| draft-ietf-netmod-yang-xml | XML Encoding of Data Modeled with YANG (rev 01, Oct 2026) | P0 (track) | Pulls the XML rules out of 7950 into one place, like 7951 did for JSON. Follow it as the clearer statement of the rules, and keep 7950 as the authority until it is an RFC. |
| **7951** | JSON Encoding of Data Modeled with YANG | **P0** | Member names `module:name` at namespace changes only, lists and leaf-lists as arrays, 64-bit integers and `decimal64` as strings, `empty` as `[null]`, `identityref` as `"module:id"`, `instance-identifier` with module-name prefixes, union member selection (§6.10), and `@` annotations (§5.2.1). The reason this package exists. |
| 9254 | Encoding of YANG Data in CBOR (YANG-CBOR) | P2 | Third codec over the same instance tree. Needs SIDs. |
| 9595 | YANG Schema Item iDentifier (YANG SID) | P2 | `.sid` files mapping schema nodes to integers. A small format, but it needs a deterministic schema-node enumeration, which the compiled tree already gives us. |
| 9997 | YANG-CBOR: SID ranges for PEN holders | P3 | Registry policy. |
| 6110 | Mapping YANG to DSDL (RELAX NG / Schematron) | P3 | Superseded in practice by native validators (pyang's DSDL plugin is the only real user). Not implemented. |

## 4. Module sets, datastores and discovery

How a server tells a client which modules, revisions, features and deviations apply. @node-net/yang **consumes** this data to build a schema context. Fetching it is protocol work and belongs to @node-net/netconf (or a RESTCONF package).

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| **8525** | YANG Library (updated by 10035) | P1 | Datastore → schema → module sets, each with modules, import-only modules, features and deviations. @node-net/yang's input type: "build me a schema context from this library", one per datastore. |
| 10035 | YANG Library: the augmented-by list (Aug 2026) | P1 | Lets a server list which modules augment each module, so the compiler can fetch dependencies without a full scan. Use it when present. |
| 7895 | YANG Module Library (obsoleted by 8525) | P1 | Older servers only offer `modules-state`. Accept it as an alternative input. |
| 7950 §5.6.4 / 6020 §5.6.4 | Module capability URIs in `<hello>` (`?module=…&revision=…&features=…&deviations=…`) | P1 | The YANG 1.0 discovery path. @node-net/yang accepts the parsed list; parsing the hello stays in @node-net/netconf. |
| **8342** | Network Management Datastore Architecture (NMDA) (updated by 8808, 10016) | P1 | Per-datastore schemas (config false data only in `<operational>`) and the `ietf-origin` annotation. Affects which nodes a query or codec accepts for a given datastore. |
| 10016 | System-Defined Configuration (2026) | P2 | Adds a `<system>` datastore. Needs nothing if datastores are an open set, as in @node-net/netconf. |
| 8528 | YANG Schema Mount | P2 | A mount point inside one schema carries a whole other schema (used by 8529 network instances and 8530 logical network elements, and by some vendors). Needs the schema context to nest. Design the context so a node can hold a child context, but don't implement it yet. |

## 5. File formats and tooling output

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| 7950 §13 (YIN) | The XML syntax of YANG modules | P1 | Some vendors publish YIN, and `<get-schema>` can return `format=yin`. A second front end that produces the same statement tree. |
| 8340 | YANG Tree Diagrams (updated by 8791) | P1 | Printing the compiled tree as `+--rw name? type`. Cheap once we have a compiled tree, and directly useful for nnc and docs. |
| 9195 | A File Format for YANG Instance Data | P1 | Reading and writing instance-data files (XML or JSON) with a header naming the module set. A natural on-disk format for test fixtures, offline config and snapshots. |
| 6643 | Translation of SMIv2 MIB modules to YANG | P3 | A converter, not runtime work. |

## 6. Guidelines and versioning

| RFC | Title | Tier | What it means for @node-net/yang |
|-----|-------|------|----------------------------|
| 9907 | Guidelines for Authors and Reviewers of Documents Containing YANG Data Models (BCP, 2026; obsoletes 8407, which obsoleted 6087) | P2 | The rule set behind `pyang --ietf`. A later lint mode. |
| draft-ietf-netmod-yang-module-versioning | Updated YANG Module Revision Handling (rev 17) | P2 (watch) | Extends `import` with a minimum revision, and marks non-backwards-compatible revisions. Compiler hooks via the extension registry. |
| draft-ietf-netmod-yang-semver | YANG Semantic Versioning (rev 29) | P2 (watch) | Extension statements. Parse and expose; no semantics yet. |
| draft-ietf-netmod-yang-packages | YANG Packages (rev 11) | P2 (watch) | Another way to describe a module set. A future input to the schema context, alongside 8525. |
| draft-ietf-netmod-yang-schema-comparison | YANG Schema Comparison | P2 (watch) | A schema diff. Possible later feature over two compiled contexts. |
| draft-ietf-netmod-immutable-flag | Metadata annotation for an immutable flag | P3 (watch) | Just a 7952 annotation. Handled generically. |
| 6244 | Architecture for Network Management Using NETCONF and YANG (Informational) | — | Background reading. |

## 7. Protocols that carry YANG data

@node-net/yang depends on none of these. They are listed because the codecs and the schema API must give each of them what it needs.

| RFC | Title | What they need from @node-net/yang |
|-----|-------|------------------------------|
| 6241, 6243, 8526, 6022, 5717, 9144, 6470, 8639–8641 | NETCONF and its extensions (@node-net/netconf) | XML codec that can carry arbitrary extra attributes (`nc:operation`, `wd:default`); module source interface for `<get-schema>`; RPC/action/notification schema nodes. |
| 6243 | With-defaults (updated by 10016) | Default-value knowledge in the compiled schema, and the `report-all-tagged` annotation in both codecs. P1 in @node-net/yang terms. |
| 8040, 8527, 8650 | RESTCONF, its NMDA extensions, RESTCONF subscriptions | JSON codec, XML codec, and a RESTCONF data-resource identifier (7951-style instance-identifier paths). A future sibling package. |
| 8072 | YANG Patch Media Type | Patch payloads are YANG data (`rc:yang-data`), so 8791/8040 support covers parsing them. P2. |
| 8341 (obsoletes 6536) | NACM | Server-side. The `nacm:default-deny-write`/`-all` extensions are exposed as node metadata, nothing more. P3. |
| draft-ietf-core-comi | CORECONF | YANG-CBOR plus SIDs (9254, 9595). P2. |
| draft-ietf-netconf-list-pagination | List pagination for YANG-driven protocols | Protocol parameters. No @node-net/yang impact beyond list ordering. |

## Scope decision

The full stack is parse → compile → instance data → codecs → validation. Milestones follow the first two use cases (XML ↔ JSON and nnc completion), then work outwards.

| Milestone | Delivers | RFCs |
|-----------|----------|------|
| **M1 Parse** (done) | YANG text → statement tree with source locations. Lexer per 7950 §6 (quoted strings and their whitespace trimming, `+` concatenation, comments). Substatement and cardinality checks driven by a versioned grammar table. | 7950 §6, §14; 6020 |
| **M2 Compile** (done) | Module source interface (filesystem, in-memory, bundled IETF modules, async callback) → schema context. Imports and includes with revisions, submodules, grouping/uses with refine and augment, top-level augment, deviations, features and `if-feature` expressions, typedef chains and restrictions, identities with multiple bases, leafref target resolution, extension registry. XSD regex translation. | 7950 §5, §7, §9; 6020; 9911; 7952 (as an extension) |
| **M3 Instance data and codecs** (done) | Instance tree with annotations; XML ↔ tree ↔ JSON 7951; schema query API (`children(path)`, node kind, keys, types, enums, defaults, descriptions, config) for nnc completion. | 7950 XML rules, draft yang-xml; 7951; 7952 |
| **M4 Server schemas and outputs** (done) | Schema context from YANG library, `modules-state` or a hello module list, per datastore; with-defaults handling; YIN input; tree diagrams; instance-data files; `sx:structure` and `rc:yang-data`. | 8525, 10035, 7895, 8342, 6243, 7950 §13, 8340, 9195, 8791, 8040 §8 |
| **M5 Validation** (done) | XPath 1.0 engine with the YANG function library; `must`, `when`, leafref and instance-identifier integrity, `unique`, `min-elements`/`max-elements`, `mandatory`, choice exclusivity. | 7950 §6.4, §8, §10; XPath 1.0 |
| **M6 Edits and diffs** (done) | An edit engine: the content of `<edit-config>` and `<edit-data>` applied to a copy of a datastore's tree, with `merge`, `replace`, `create`, `delete` and `remove`, the default operation, `yang:insert` for ordered-by-user entries, and the implicit deletion of other cases. A diff of two data trees, and an edit made from it. | 6241 §7.2, 8526 §3.2.2, 7950 §7.7.9, §7.8.6, §7.9, §15.7, 6243 §4 |
| Later | Schema mount, YANG-CBOR and SID files, lint mode (9907), schema comparison, YANG 2.0, YANG packages, module versioning. | 8528, 9254, 9595, 9907, drafts |

**Explicitly out of scope:** DSDL mapping (6110), SMIv2 translation (6643), language abstractions (6095), NACM enforcement (8341), and anything protocol-specific. That last one is a hard rule: @node-net/yang never depends on @node-net/netconf.

**M2 decisions and known gaps.**

- *Namespace binding.* Nodes from a grouping take the namespace of the module where the outermost `uses` appears. Names inside the grouping (types, groupings, identities, features) resolve in the grouping's own module (RFC 7950 §7.13).
- *Implicit implementation.* A module that is only imported becomes implemented when an augment path or a leafref path names it, since its nodes are then part of the schema (RFC 7950 §5.6.5; libyang does the same for leafrefs).
- *Features* are all enabled unless the caller lists a module's enabled features. A server's YANG library will supply them in M4.
- *Defaults* are checked against their type, including identityref derivation and leafref targets. A typedef's default applies to leaves without their own.
- *Checked against pyang:* every IETF RFC module, compiled together, and every OpenConfig module, compiled together, give the same trees as pyang 2.7.1: 39,850 nodes, with the same kind, name, namespace module, config, base type, keys and mandatory flag.
- *Not yet:* Unicode block escapes (`\p{IsBasicLatin}`) in patterns (none appear in the corpus). More than one revision of a module in a set (done in M4). YANG 1.0's narrower submodule visibility (done after M6, as a warning: see the design doc, §6.4). Checks of `status` references (done after M6, as warnings: see the design doc, §6.4), of mandatory nodes added by augment, and of default cases containing mandatory nodes (both done after M6: see the design doc, §6.3). Leafref predicates are skipped, not checked (done after M5: see its compile-time checks). XPath in `must` and `when` is kept as text for M5 (done in M5).

**M3 decisions and known gaps.**

- *XML parser.* @node-net/yang depends on `@rgrove/parse-xml` (the parser @node-net/netconf uses, so npm installs one copy) only to read XML text. The decoder takes a structural `XmlElementLike` interface that @node-net/netconf's `XmlElement` satisfies as it is, and the encoder returns plain objects of the same shape, so the two packages pass parsed trees to each other without serialising. As in @node-net/netconf, a DOCTYPE is rejected and depth and size are limited.
- *Values are typed.* `number` for integers up to 32 bits, `bigint` for 64-bit ones, a `Decimal64` (scaled bigint and fraction digits), `boolean`, `null` for empty, `Uint8Array` for binary, `string[]` for bits in position order, `Identity` objects, and parsed `InstanceIdentifier`s resolved against the schema. Each value keeps the concrete type it was read as (a leafref's target type, the union member that matched), since that decides its JSON form. Output is always canonical (RFC 7950 §9).
- *Order.* Children are kept in schema order with list keys first, the order RFC 7950 requires for keys and RPC parameters and the order libyang prints. Top-level nodes keep the order they were added in.
- *Operations* are written as their own element or member, holding the input or output parameters, inside their data ancestors for actions and nested notifications: libyang's form. The `operation` option reads bare parameters (a NETCONF `<rpc-reply>`, or RESTCONF's `module:input`/`module:output` wrapper in JSON), and with type `notification` a notification's bare content, building the keyed ancestors of a nested one from its path; to write bare parameters, encode the operation's children.
- *Annotations.* Every XML attribute on a data element is kept as an annotation: typed when a module in the schema defines it with `md:annotation`, text otherwise. So `nc:operation`, `wd:default` and unknown attributes pass through untouched. JSON needs a module name for each, found from the schema or from the codecs' `namespaces` option (namespace URI → module name), which is how a caller maps namespaces that belong to no YANG module, without @node-net/yang knowing NETCONF.
- *Prefixes in XML output.* The default namespace changes where the module changes. Prefixes used inside a value (identityref, instance-identifier) are declared on the value's own element, so it stands alone if cut out; annotation prefixes reuse a binding in scope. Both are libyang's style.
- *JSON details.* Identityrefs are always written `module:identity` (RFC 7951 §6.8 allows it everywhere). Leaf-list metadata arrays keep trailing nulls (RFC 7952 §5.2.4 allows either; libyang keeps them). On input, a member name may be qualified where the simple form would do.
- *Errors.* Decoding collects every problem and throws one `YangDataError` whose `issues` each have a code (`unknown-node`, `wrong-namespace`, `invalid-value`, `missing-key`, `duplicate-node`, `duplicate-entry`, `unexpected-content`, `unknown-annotation`, `unexpected-operation`, `xml-syntax`, `json-syntax`, …) and the RFC 7951 data path of the node. `unknown: 'skip'` drops nodes the schema doesn't have instead.
- *Lenient on input, strict on output.* XML list keys are accepted in any order (libyang rejects them out of order), leading and trailing whitespace is ignored in non-string XML values, and an unprefixed name in an XML instance-identifier is taken to be in the previous step's module. JSON is strict about value types (a 32-bit integer must be a JSON number, a 64-bit one a string), as libyang is.
- *Schema queries* (`children`, `describe`, `complete`) read paths tolerantly for interactive use: a step may name its module by module name or YANG prefix, or not at all when unambiguous, and predicates are skipped. Completion offers node names, list key names after `[`, and key values after `=` when the key's type is a closed set (enumeration, identityref, boolean, or a union or leafref of them). A completion that doesn't simply extend what was typed (`ip` → `ietf-ip:ipv4`) is flagged, since line editors that only append can't use it.
- *Checked against yanglint* (libyang 2.1.30, Debian bookworm) by scripts/yanglint-oracle.sh and test/oracle.test.ts: sample data over ietf-interfaces with ietf-ip, ietf-routing with the IPv4 and IPv6 unicast modules, ietf-yang-library, and a test module covering every built-in type, annotations, augments, RPCs, actions, replies and notifications. XML → XML, XML → JSON, JSON → XML and JSON-only input all give exactly yanglint's output. 14 invalid samples, XML and JSON, are rejected with the expected issue and path; yanglint rejects 13 of them, and accepts a duplicate leaf only because `-t get` doesn't validate.
- *Not yet:* everything in M5: must, when, leafref and instance-identifier integrity, unique, min/max-elements, mandatory, choice exclusivity, duplicate leaf-list values (done in M5). State data is accepted in any tree; per-datastore schemas (NMDA) come with M4, as does with-defaults handling (`wd:default` uses a namespace that isn't its module's, so callers map it with `namespaces` until then). Both are done in M4. anydata and anyxml content is kept in the encoding it was read in; converting it to the other encoding is structural and lossy, as in libyang, and anydata isn't decoded against the schema. Issues carry data paths, and line and column numbers with the `positions` option (done after M6). There is no path-based API for building trees yet (nodes are created and appended directly), and no streaming: documents are decoded whole.

**M4 decisions and known gaps.**

- *Schemas per datastore.* `compileYangLibrary(library, { source })` gives `ServerSchemas`: one compiled `Schema` per library schema, each distinct module set compiled once and shared, and a view per datastore (`schemas.datastore('running')`). A view is `schema.forDatastore(name)`: the same compiled modules, with `datastore` and `holdsState` set. Datastores are an open set of identities. `<operational>` and datastores derived from `ds:dynamic` hold state data; every other one, `<system>` (RFC 10016) and vendor datastores included, is a configuration datastore unless the caller says otherwise. In a configuration datastore's view the codecs reject state data (`state-data`) and the `or:origin` annotation (`unexpected-annotation`), queries leave state nodes out, and `addDefaults` adds no state defaults. Libraries without datastores (RFC 7895, a hello) serve every datastore from their one schema.
- *Library input.* `readYangLibrary` takes the RFC 7951 JSON form or a decoded `DataTree`; `decodeYangLibrary` reads XML or JSON text before any schema exists, with the bundled ietf-yang-library (whose 2019 revision keeps the deprecated `modules-state`) and RFC 10035's augmented-by module. `fromCapabilities` builds the same `YangLibrary` from a hello's capability URIs, and `parseModuleCapability` parses one: the URI format is defined by YANG (RFC 7950 §5.6.4), not by the protocol, so it lives here, while parsing the hello stays in @node-net/netconf. The library says which modules, revisions, features and deviations; a `ModuleSource` still supplies the text. `only` compiles a subset of the implemented modules plus those that deviate or augment them, using the RFC 10035 augmented-by lists (with a warning when the library has none).
- *Features from a library* are exactly those listed for implemented modules. Import-only modules have none enabled (`importOnlyFeatures: false`), as libyang does.
- *Several revisions of a module.* A set can hold one module in several revisions: one primary revision (the implemented one, or else the latest requested) and secondary ones loaded because an import names them with `revision-date`. Secondary revisions are never implemented. `schema.modules` has one entry per name, the primary; `schema.allModules` and `schema.module(name, revision)` reach the others. An import without a revision date gets the primary revision. When a source lacks the revision an import names, the primary one is used with a `revision-mismatch` warning.
- *Deviations* are recorded on the module the deviation path starts in (`CompiledModule.deviations`), as libyang records them, which is what `yangLibraryData(schema)` reports. That function writes any schema as RFC 8525 data: for comparing with other tools and for RFC 9195 headers.
- *if-feature and missing targets.* A `refine`, `augment` or `deviation` aimed at a node an `if-feature` removed is ignored, as libyang ignores it; M2 reported it as an error, which the corpus never showed because it compiled with every feature enabled. netopeer2's library (`ietf-subscribed-notifications` without `configured`) showed it. Likewise the leafrefs, list keys, choice defaults and default values inside a subtree that `deviate not-supported` removed aren't checked, as libyang doesn't check them; a leafref still in the schema whose target was removed is an error in both. Nokia SR OS showed it: its deviations remove `/if:interfaces` and parts of OpenConfig, which gave 38 false errors.
- *With-defaults* is a set of tree operations, not codec options: `addDefaults(tree)` and `applyWithDefaults(tree, mode)` change a tree in place, and nodes added for a default have `isDefault` set. Defaults are typed at compile time (`LeafNode.defaultValue`, `LeafListNode.defaultValues`), with prefixes resolved in the file that declares them, so identityref and decimal64 defaults compare by value. The modes follow libyang: `explicit` keeps written values equal to the default and state data defaults; `trim` removes leaves equal to the default and leaf-list entries equal to one of the defaults; `report-all-tagged` tags what `trim` would remove. Empty non-presence containers are dropped in every mode (libyang keeps one in trim mode when it held written leaves).
- *The `default` annotation* is known to both codecs without the ietf-netconf-with-defaults module: the XML attribute in `urn:ietf:params:xml:ns:netconf:default:1.0` (RFC 6243 §6, written `wd:` unless the schema has the module, whose prefix is used), and the JSON member `ietf-netconf-with-defaults:default` (RFC 8040 §4.8.9), typed boolean. libyang 2.1 writes the attribute in the module's own namespace instead, and omits it from JSON; the XML decoder accepts that namespace too.
- *YIN* is a second front end giving the same `Statement` tree, with locations. `ModuleText.format` says which syntax a text is; without it, text starting with `<` is YIN, and `fileSource` finds `.yin` files. An extension's argument comes from its definition when the file has it, and otherwise from the element's one attribute, or its one text-only child in the extension's namespace; that heuristic can misread an extension whose first substatement is an argument-less extension of the same module. `writeYin` writes the reverse.
- *Tree diagrams* match `pyang -f tree` byte for byte, rather than yanglint's: RFC 8340's own diagrams are pyang's, and pyang is already the compile oracle. That meant porting its rules exactly, oddities included: children of a notification nested in data have no flags, an RPC's implicit input or output comes before written ones, and nodes from several augmenting modules appear in pyang's validation order. To get that order the compiler now orders modules depth first from the requested ones with imports in written order, and implements the modules augment paths name before building anything. Groupings aren't printed (pyang prints them only with `--tree-print-groupings`). Structures and yang-data are printed by default.
- *Structures.* `md:annotation`, `sx:structure`, `sx:augment-structure` and `rc:yang-data` are compiled by extension handlers (src/compile/extensions.ts), matched by the defining module and name, so new extensions plug in there. A structure compiles to a container named after it (RFC 8791 §3 encodes it so) and yang-data to its container, listed in `CompiledModule.structures`, never in datastore content. Inside a structure lists need no key and `config` is ignored; an absolute path starts at the structure's top, falling back to datastore data, which published modules (DOTS) rely on. The codecs read and write structures with `type: 'structure'` (and `structure: 'module:name'` to pin one).
- *Instance-data files.* `readInstanceData` checks the header against the bundled ietf-yang-instance-data, applying its defaults, and keeps the content to decode once its schema is known: `file.compileSchema(source)` builds it from a simplified-inline module list (every feature) or an inline YANG library (exact), viewed for the header's datastore; a URI content schema is left to the caller. `writeInstanceData` names the content's schema as a module list or inline library, and can apply a with-defaults mode, recording it as `includes-defaults`. All three examples in RFC 9195 §2.2 have errors that a strict reader rejects (prefixed feature names, a misspelt leaf, padded member names, counters as JSON strings); test/fixtures/instance-data has them, corrected where needed, and says how.
- *Checked against:* yanglint `-Y` for YANG library contexts (a fixture library, the same as `modules-state`, and netopeer2's own library taken from a throwaway container: modules, revisions, features, deviations, submodules and import-only modules all the same); yanglint `-d` for with-defaults (seven cases); `pyang -f yin` for all 842 corpus files (each parses to the statement tree its YANG gives); `pyang -f tree` for all 104 IETF RFC modules that print anything, compiled together, at full width and folded at 69 columns.
- *Not yet:* `when` isn't evaluated (M5), so defaults guarded by `when`, their own or from a `uses` or `augment`, are never added (done in M5). Schema mount. Diagram groupings. The hello's YANG 1.1 library capability is reported (`fromCapabilities(...).library`) but fetching the library it points to is the caller's. Deviations of nodes inside structures, and `sx:augment-structure` of a yang-data, aren't supported. libyang only checks `modules-state` when there is no `yang-library`, so the RFC 7895 reader is checked by giving it the same library as the 8525 fixture.

**M5 decisions and known gaps.**

- *XPath engine.* src/xpath has an XPath 1.0 parser (W3C XPath 1.0 §3, with the lexical rules of §3.7), a printer, and an evaluator over instance trees. Validation uses it, and it is exported (`evaluateXPath`, `parseXPath`, `printXPath`) for subtree and XPath filters and YANG Push later. Nesting deeper than 128 levels is refused when parsing, and every evaluation has a budget of visited nodes (10 million by default), so a hostile expression can neither exhaust the stack nor hang.
- *Compile-time checks.* Every `must`, `when` and leafref `path` in the implemented modules, structures included, is parsed when the schema is compiled, and the parse is cached for validation. Errors: `xpath-syntax`, `xpath-unknown-prefix`, `xpath-unknown-function`, `xpath-arguments`, `xpath-unknown-variable`, and `invalid-path` for a leafref path outside the path grammar, predicates included. Warnings: a YANG 1.1 function in a YANG 1.0 file (judged by the file the expression is written in, not the module whose nodes it ends up on), and a `derived-from` identity that doesn't exist. Leafref path predicates are also checked against the schema, as libyang checks them: the step must be a list, each predicate's key one of its keys and named once, and its `current()/../…` path must stay within the tree and lead to a leaf (`leafref-invalid-predicate`); the steps after a predicate are resolved like the others. The 272 predicates in 236 distinct corpus paths all pass. The paths in `must` and `when` are also followed through the schema, from their context nodes and within the accessible tree: a step that can select nothing is a warning (`xpath-unknown-node`, `xpath-state-from-config`, `xpath-not-implemented`), and so are `when` conditions that depend on each other (`when-cycle`); see net-yang-design.md §6.3. The analysis gives up rather than risk a false warning. The 13 statements it finds in the IETF, OpenConfig and SR OS sets are all genuine. All 1,471 `must` and `when` expressions and 2,486 leafref paths of the IETF and OpenConfig corpus parse; the IETF set gives 7 warnings, all genuine (identities missing from the corpus's iana-if-type). Checked against pyang 2.7.1 and yanglint 2.1.30 on 20 fixture modules, one problem each (pyang crashes on some wrong argument counts, so one module per case): the same verdict on all but three. pyang accepts XPath variables, which libyang and @node-net/yang refuse, since YANG binds none; pyang also accepts one list key named in two leafref predicates, which both refuse. yanglint doesn't check the prefix of an identity named in a `derived-from()` literal.
- *Context rules.* A `when` records where it came from (`WhenCondition.from`). A node's own `when` has the node as its context node; one from `uses` or `augment`, and that of a choice or case, has the closest data ancestor (RFC 7950 §7.21.5). Unprefixed names are in the module of the node the expression belongs to (§6.4.1), so a grouping's expressions take the module where it is used. In a `data` tree with no datastore, expressions on configuration nodes see configuration only (§6.4.1), as libyang's do; in a datastore's tree they see the whole tree. An operation tree's expressions see the operation and the `operational` data: an action or nested notification hangs under its parent's counterpart there, as with yanglint's `-O`, and a parent that isn't there is `missing-parent`. A structure's own nodes are the children of the root (RFC 8791), with the `operational` data alongside for paths that lead out of it.
- *Values in XPath.* Node-sets are arrays of instance nodes, with the `DataTree` as the root, in document order. String values are canonical forms: identityrefs are `module:identity` and instance-identifiers their RFC 7951 form, as in libyang. A leaf compared with a string is compared with the string read as a value of the leaf's type, with the expression's prefixes, in canonical form (libyang's behaviour), so `type = 'ianaift:ethernetCsmacd'` and `d = '1.50'` match. Numbers are doubles, as XPath 1.0 has them: 64-bit integers beyond 2^53 and long decimal64 values lose precision in arithmetic and in `<` and `>`, while `=` compares canonical strings and is exact. `name()` gives `module:name`.
- *API.* `validate(tree, options)` returns the issues and never throws for problems in the data; `assertValid` throws a `YangDataError` of the errors; the decoders' `validate` option (`true` or the options) validates data that decoded without problems. `DataIssue` gained `severity` (required: decoding problems are errors) and, where they apply, `appTag`, `expression`, `location`, `nonUnique` and `missingChoice`. Codes: `when-false`; `must-violation` (the message is the `error-message` when there is one, the app tag the `error-app-tag` or `must-violation`); `missing-instance` (`instance-required`); `not-unique` (`data-not-unique`, with the leaves of both entries in `nonUnique`); `too-few-elements` and `too-many-elements`; `missing-mandatory`; `missing-choice` (on the choice's parent, as RFC 7950 §15.6 has it); `multiple-cases`; `duplicate-entry` (configuration leaf-lists only, since state leaf-lists may repeat values); `missing-parent`; `xpath-error`. A missing node's path is the path it would have. Mapping codes to NETCONF error-tags (`data-missing`, `operation-failed`, …) is @node-net/netconf's job; @node-net/yang stays protocol-agnostic.
- *Order.* `validate` adds every default and creates every non-presence container, as libyang does, so that their `must` expressions run and their mandatory descendants are found missing. It then resolves `when` conditions in document order, postponing one that selects a node whose own condition isn't resolved yet until a pass makes no progress, and then evaluating what is left in order. A default whose condition is false is removed; a written node whose condition is false is reported and its subtree skipped. Then come `must`, references and the checks on children. What was added is removed at the end, unless `keepDefaults`. `addDefaults` is the first two steps, without the empty containers. A mandatory node's own `when` is evaluated with a stand-in instance, as libyang does, so a mandatory leaf under a false condition isn't required.
- *Differences from libyang, on purpose.* libyang evaluates `when` conditions in reverse order and counts a default it has just added as having a true condition, so a default whose condition depends on another default that is then removed stays: with the fixture of test/data/defaults.test.ts and `a` set to `q`, libyang keeps `d`. @node-net/yang follows RFC 7950: the removed default doesn't exist, so `d` isn't added. libyang refuses a schema with mutually dependent `when` conditions; @node-net/yang warns (`when-cycle`), compiles it and evaluates them in order.
- *Datastores and partial data.* Configuration datastores, and trees not tied to a datastore, report every broken constraint as an error. `<operational>` and other datastores that hold state data report broken semantic constraints (`when`, `must`, references, `unique`, element counts, mandatory nodes, repeated leaf-list values) as warnings, since RFC 8342 §5.3 allows them, and structural ones (data from two cases, a missing action parent) as errors; `semantics` overrides that. `partial` skips missing mandatory nodes and choices, too few elements and missing reference targets; it is the default when `InstanceDataFile.decode` validates, since RFC 9195 allows partial data. A tree without a datastore holds state data, which is validated like configuration, as yanglint `-t data` does.
- *Performance.* Leafref paths without predicates collect their targets' values once per starting node. A `[name = expression]` predicate whose right side doesn't depend on the context node (leafref path predicates, most lookups in `must`) goes through an index of the parent's children by that child's value. `unique` uses a hash per list instance. Parsed expressions are cached per expression. 380,000 nodes of ietf-interfaces/ietf-ip and ietf-routing (20,000 interfaces with addresses, 20,000 static routes referring to them) validate in 0.3 seconds, and 200,000 nodes of one list with leafrefs with predicates, `unique` and `must` in 0.3 seconds, on Node 22 on a laptop. test/validate/performance.test.ts fails on a quadratic regression (the first version took 25 seconds there).
- *Checked against yanglint* (libyang 2.1.30) by scripts/yanglint-oracle.sh: 44 fixture cases, each breaking one rule or none, over two test modules (one of them for leafrefs with several predicates and `current()/../..` paths) and over ietf-interfaces with ietf-ip, ietf-routing with the IPv4 and IPv6 unicast modules, and ietf-netconf-acm, with `-t data`, `config`, `rpc`, `reply`, `notif` and `-O`. Each gets the same verdict, with an error at the path yanglint names (yanglint names the first entry beyond `max-elements`, either entry of a pair that breaks `unique`, and a schema location for a missing node, which the test maps). 400 random documents from scripts/validate-samples.mjs (fixed seed) agree in the same way. Defaults guarded by `when` were checked with `yanglint -d all`.
- *XPath values.* Values of type `yang:xpath1.0` (RFC 6991, now RFC 9911) and typedefs derived from it, such as NACM's `node-instance-identifier` (RFC 8341), are checked as XPath when read: syntax, prefixes (namespaces in scope in XML, module names in JSON), and functions with their argument counts, with variables allowed. As in libyang, a prefix must name a module the schema has, so NACM's `path` needs the modules it names. Unlike libyang, which reads `node-instance-identifier` as an instance-identifier resolved against the schema (so `$USER` and unknown nodes are refused), @node-net/yang doesn't look names up. Values are held with module names as prefixes, libyang's JSON form, and written with namespace prefixes in XML.
- *Not yet:* A `re-match` pattern written as a literal is checked only when evaluated. The attribute and namespace axes are empty, since annotations aren't exposed to XPath, and `id()` and `lang()` find nothing. Validating an edit (the result of `nc:operation`s) and NACM are out of scope (edits are applied, and the result validated, in M6). netopeer2 wasn't used as an oracle: yanglint covers the same library.

**M6 decisions and known gaps.**

- *API.* `applyEdit(target, edit, options)` returns a new tree and leaves `target` alone; `defaultOperation` is `merge` (the default), `replace` or `none`, and `validate` validates the result, as a server does for `<running>`. Every problem is reported in one `YangDataError` and nothing is applied, as with `rollback-on-error`. Codes: `data-exists` (`create` of a node that exists), `data-missing` (`delete` of one that doesn't), `missing-anchor` (app tag `missing-instance`, RFC 7950 §15.7: the entry `yang:key` or `yang:value` names isn't there), `multiple-cases` (an edit that writes two cases of one choice), `invalid-edit` (state data, operations, a malformed or self-referring anchor, a list entry without its keys, a leaf with no value to write). `diffEdit` throws `unwritable-anchor` when it would place an entry after one whose key holds both quote characters, which `yang:key` can't express. Mapping them to NETCONF error-tags (`data-exists`, `data-missing`, `bad-attribute`, …) is @node-net/netconf's job. `diffTrees(from, to, options)` returns `DataChange`s (`create`, `delete`, `replace` of a leaf, or of an anydata or anyxml node whose content means something different (JSON member order, prefixes and whitespace between elements don't count, and XML is compared with JSON), `move` of an ordered-by-user entry, with its `position`, and `origin` for a changed `or:origin`); `diffEdit(from, to)` and `editFromChanges` turn them into an edit tree. The edit's nodes must come from the same compile as the target's (any datastore schema of it), since nodes are matched by schema node.
- *Semantics.* An operation is inherited from the closest ancestor that has one. `replace` makes a node's configuration exactly the edit's (state data inside is kept); the children the edit names are applied first, so a `delete` inside a `replace` still needs its node. `none` creates a container or list entry only when something below it is created. A non-presence container the edit leaves empty is removed. A leaf's value is ignored when deleting it; the decoders' `edit` option lets it be left out (an empty XML element, or `null` in JSON). Edit annotations are not copied into the result; other annotations are.
- *Order.* A new ordered-by-user entry goes last unless `yang:insert` says otherwise; an existing one moves only when it has `yang:insert`, or when its parent is replaced, in which case the entries take the edit's order (sysrepo does the same). Prefixes in `yang:key` and `yang:value` resolve to the XML namespaces in scope where they were read (the XML decoder's `edit` option keeps them on the annotation as `prefixes`), then to module names, then to YANG prefixes. The XML encoder declares the module names used as prefixes in them, so an edit made from JSON or by `diffEdit` is namespace-well-formed XML.
- *Diffs.* Entries of ordered-by-user lists and leaf-lists that keep their relative order are those of a longest increasing subsequence of their old positions; the others are moved, each after its predecessor in the new order. Ordered-by-system entries are compared as sets. Annotations other than `or:origin`, and `isDefault`, aren't compared. `diffEdit` writes `create`, `delete` and `replace`, and `merge` with `yang:insert` for moves; it leaves out the deletion of nodes in a case that a created node replaces, since the server deletes them. `yang:key` names keys with their module (`[ed:name='a']`).
- *Differences from sysrepo, on purpose.* Checked with sysrepo 2.2.36 (libyang 2) from the netopeer2 image by scripts/sysrepo-edit-oracle.sh: 37 cases of test/fixtures/edit/cases.txt, all with the same verdict and, when accepted, the same `<running>`, except three. `delete` of a leaf that only has its default value fails with `data-missing`, as RFC 6243 §4 has it for the `explicit` basic mode; sysrepo, which reports `explicit`, deletes nothing and succeeds. `delete` of a non-presence container with no content fails with `data-missing` (RFC 6241 §7.2); libyang has every non-presence container, so sysrepo succeeds. An XML prefix in `yang:value` resolves through the namespaces in scope; libyang maps it with the schema's YANG prefixes, so `e:widget` with `xmlns:e` bound to the module fails there. sysrepocfg can only apply the `merge` default operation, so `replace` and `none` as defaults are unit-tested only. A property test checks that `applyEdit(from, diffEdit(from, to))` gives `to` for random trees, also through XML and with the `none` default operation.
- *Performance.* Target children are indexed by schema node and key or value, so matching is constant time, and `append` finds its place by binary search. Merging 40,000 list entries into 40,000, diffing the result and re-applying the diff's edit takes about a second (test/edit/performance.test.ts; the first version took 45 seconds). Each `yang:insert` with an anchor still costs time linear in the number of siblings.
- *Error options.* `tryApplyEdit(target, edit, { errorOption })` takes `<edit-config>`'s three `<error-option>` values (RFC 6241 §7.2) and returns `{ tree, errors, rejected }` instead of throwing; `applyEdit` is it with `rollback-on-error` (the default) plus a throw, so `errorOption` isn't on `EditOptions`. RFC 6241 leaves the order of processing to the server; here it is the order of the decoded edit tree, depth first: a node's own operation, then its children (in schema order, with list and leaf-list entries in the order given), then the removal a `replace` makes of the children it didn't name. An error belongs to the edit node it is found at, and the unit that fails is that node with its subtree, not a whole operation (with the default `merge`, that would make the top-level container the unit) and not the node alone (its children have nowhere to go). Choice cases and `yang:insert` anchors are checked before the node changes anything, so a failing node leaves no trace. `stop-on-error` keeps what was applied before the first error and nothing after it; a `replace` the stop cuts short doesn't remove the children it didn't name, and its node ends up merged up to the stop. `continue-on-error` skips each failing node and applies the rest. A skipped node leaves the data it names as it was, also under a `replace`. Anchors and choices are judged against the data as it is when the node is reached, so an anchor that a skipped node would have created is `missing-anchor`, and a node in another case than a skipped one is no conflict. `rollback-on-error` reports every error, as before (`:rollback-on-error`, §8.5, is the server's to advertise). `validate` runs on the result unless the edit is already rejected, on the partial result under the other two options, and a validation error rejects the whole edit whatever the option.
- *Origins (RFC 8342 §7.4).* In `<operational>`, a configuration node's origin is its own `or:origin` or, failing that, its nearest ancestor's; `effectiveOrigin(node)` reads it (the identity when the schema has ietf-origin, the text otherwise). Origins are compared by identity (module and name), not by the prefix written, so `or:learned` in XML equals `ietf-origin:learned` in JSON, and a vendor identity derived from `or:learned` is a different origin. `diffTrees` compares effective origins when both trees' schemas hold state (`origin: false` or `true` overrides): an `origin` change, with `origin` and `previousOrigin`, is listed for a node whose effective origin changed and that has an origin of its own in either tree, so a container's change isn't repeated for the children that inherit it, and making an inherited origin explicit is no change. `diffEdit` writes it as `merge` with the new `or:origin`. In a target that holds state, `applyEdit` and `tryApplyEdit` replace a node's origin with the edit node's, however either was identified (namespace or module), and drop it where it equals what the node inherits; a node created without one inherits. Configuration datastores' trees are handled as before. @node-net/netconf's `compareDatastores` compares configuration datastores and passes `origin: false`.
- *Not yet:* `<copy-config>`-style replacement of a whole datastore beyond `defaultOperation: 'replace'`; NACM; YANG Patch (RFC 8072) payloads, which @node-net/netconf can build from `DataChange`s; anydata and anyxml content is compared structurally, without its schema, so text values are compared as written rather than as typed values. Edits replace it whole, as §7.10.3 and §7.11.3 require. A `yang:key` value containing both quote characters can't be written, since XPath 1.0 has no escapes and libyang refuses `concat()` in `yang:key` (tried with sysrepo on NACM's ordered-by-user `rule-list`), so `diffEdit` refuses rather than write one. Data paths write such values as `concat()`.

**Interpretation: tabs in double-quoted strings.** RFC 7950 §6.1.3 says a tab examined for indentation stripping counts as 8 spaces, but doesn't say how to count a tab *before* the opening quote. We count it as 8 columns too, as libyang does. pyang counts both differently, which is the only way our parse of the 739-module corpus differs from pyang's (about a dozen strings, all in modules indented with a mix of tabs and spaces).

**Test strategy that follows from this.** The 114 data-model RFCs, OpenConfig and the Nokia models are the compile corpus. `yanglint` (libyang) and `pyang` are oracles at test time only: expected compile results, tree diagrams and XML ↔ JSON pairs are generated with them, in throwaway containers, into the git-ignored corpus cache, and the tests compare against them when present. Neither tool is ever a runtime dependency.

## Sources

- RFC Editor index: <https://www.rfc-editor.org/rfc-index.xml> (fetched 2026-11-08)
- IETF datatracker, active drafts for the netmod, netconf and core WGs: <https://datatracker.ietf.org/wg/netmod/documents/>
- [RFC 7950](https://www.rfc-editor.org/info/rfc7950/), [RFC 7951](https://www.rfc-editor.org/info/rfc7951/), [RFC 7952](https://www.rfc-editor.org/info/rfc7952/), [RFC 9911](https://www.rfc-editor.org/info/rfc9911/), [RFC 8525](https://www.rfc-editor.org/info/rfc8525/)
- [draft-ietf-netmod-yang-xml](https://datatracker.ietf.org/doc/draft-ietf-netmod-yang-xml/), [draft-ietf-netmod-yang2](https://datatracker.ietf.org/doc/draft-ietf-netmod-yang2/)

## Appendix: data-model RFCs

These 114 RFCs define YANG modules and nothing else that @node-net/yang must implement. Grouped by IETF area. Obsoleted RFCs are kept because devices still ship their revisions.

### NETMOD (general-purpose models)

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 7223 | A YANG Data Model for Interface Management | netmod | obsoleted by 8343 |
| 7224 | IANA Interface Type YANG Module | netmod |  |
| 7277 | A YANG Data Model for IP Management | netmod | obsoleted by 8344 |
| 7317 | A YANG Data Model for System Management | netmod |  |
| 7407 | A YANG Data Model for SNMP Configuration | netmod |  |
| 8022 | A YANG Data Model for Routing Management | netmod | obsoleted by 8349 |
| 8343 | A YANG Data Model for Interface Management | netmod |  |
| 8344 | A YANG Data Model for IP Management | netmod |  |
| 8348 | A YANG Data Model for Hardware Management | netmod |  |
| 8349 | A YANG Data Model for Routing Management (NMDA Version) | netmod |  |
| 8519 | YANG Data Model for Network Access Control Lists (ACLs) | netmod |  |
| 8808 | A YANG Data Model for Factory Default Settings | netmod |  |
| 9179 | A YANG Grouping for Geographic Locations | netmod |  |
| 9742 | A YANG Data Model for Syslog Management | netmod |  |
| 9899 | Extensions to the YANG Data Model for Access Control Lists (ACLs) | netmod |  |
| 9922 | A Common YANG Data Model for Scheduling | netmod |  |

### NETCONF (client/server, crypto groupings)

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 9640 | YANG Data Types and Groupings for Cryptography | netconf |  |
| 9641 | A YANG Data Model for a Truststore | netconf |  |
| 9642 | A YANG Data Model for a Keystore | netconf |  |
| 9643 | YANG Groupings for TCP Clients and TCP Servers | netconf |  |
| 9644 | YANG Groupings for SSH Clients and SSH Servers | netconf |  |
| 9645 | YANG Groupings for TLS Clients and TLS Servers | netconf |  |
| 9984 | YANG Groupings for UDP Clients and UDP Servers | netconf |  |

### Routing

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 8177 | YANG Data Model for Key Chains | rtgwg |  |
| 8294 | Common YANG Data Types for the Routing Area | rtgwg |  |
| 8347 | A YANG Data Model for the Virtual Router Redundancy Protocol (VRRP) | rtgwg |  |
| 8529 | YANG Data Model for Network Instances | rtgwg |  |
| 8530 | YANG Model for Logical Network Elements | rtgwg |  |
| 8652 | A YANG Data Model for the Internet Group Management Protocol (IGMP) and Multicast Listener Discovery (MLD) | pim |  |
| 8695 | A YANG Data Model for the Routing Information Protocol (RIP) | rtgwg |  |
| 8916 | A YANG Data Model for the Multicast Source Discovery Protocol (MSDP) | pim |  |
| 8960 | A YANG Data Model for MPLS Base | mpls |  |
| 9020 | YANG Data Model for Segment Routing | spring |  |
| 9067 | A YANG Data Model for Routing Policy | rtgwg |  |
| 9070 | YANG Data Model for MPLS LDP | mpls |  |
| 9127 | YANG Data Model for Bidirectional Forwarding Detection (BFD) | bfd | updated by 9314 |
| 9128 | YANG Data Model for Protocol Independent Multicast (PIM) | pim |  |
| 9129 | YANG Data Model for the OSPF Protocol | lsr |  |
| 9130 | YANG Data Model for the IS-IS Protocol | lsr |  |
| 9166 | A YANG Data Model for Internet Group Management Protocol (IGMP) and Multicast Listener Discovery (MLD) Snooping | pim |  |
| 9194 | A YANG Module for IS-IS Reverse Metric | lsr |  |
| 9314 | YANG Data Model for Bidirectional Forwarding Detection (BFD) | bfd |  |
| 9398 | A YANG Data Model for Internet Group Management Protocol (IGMP) and Multicast Listener Discovery (MLD) Proxy Devices | pim |  |
| 9403 | A YANG Data Model for RIB Extensions | rtgwg |  |
| 9468 | Unsolicited Bidirectional Forwarding Detection (BFD) for Sessionless Applications | bfd |  |
| 9587 | YANG Data Model for OSPFv3 Extended Link State Advertisements (LSAs) | lsr |  |
| 9647 | A YANG Data Model for Babel | babel |  |
| 9702 | YANG Data Model for Maximum Segment Identifier (SID) Depth (MSD) Types and MPLS MSD | mpls |  |
| 9719 | YANG Data Model for Routing in Fat Trees (RIFT) | rift |  |
| 9764 | Bidirectional Forwarding Detection (BFD) Encapsulated in Large Packets | bfd |  |
| 9826 | A YANG Data Model for the Path Computation Element Communication Protocol (PCEP) | pce |  |
| 9902 | A YANG Data Model for IS-IS Segment Routing over the MPLS Data Plane | lsr |  |
| 9903 | A YANG Data Model for OSPF Segment Routing over the MPLS Data Plane | lsr |  |
| 9961 | MPLS Segment Routing Point-to-Multipoint (P2MP) Policy Ping | pim |  |
| 9983 | OSPFv2 Anycast Property Advertisement | lsr |  |

### Topology and RIB

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 8345 | A YANG Data Model for Network Topologies | i2rs |  |
| 8346 | A YANG Data Model for Layer 3 Topologies | i2rs |  |
| 8431 | A YANG Data Model for the Routing Information Base (RIB) | i2rs |  |
| 8542 | A YANG Data Model for Fabric Topology in Data-Center Networks | i2rs |  |
| 8944 | A YANG Data Model for Layer 2 Network Topologies | i2rs |  |

### Traffic engineering and transport

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 8432 | A Framework for Management and Control of Microwave and Millimeter Wave Interface Parameters | ccamp |  |
| 8561 | A YANG Data Model for Microwave Radio Link | ccamp |  |
| 8632 | A YANG Data Model for Alarm Management | ccamp |  |
| 8776 | Common YANG Data Types for Traffic Engineering | teas |  |
| 8795 | YANG Data Model for Traffic Engineering (TE) Topologies | teas |  |
| 9093 | A YANG Data Model for Layer 0 Types | ccamp |  |
| 9094 | A YANG Data Model for Wavelength Switched Optical Networks (WSONs) | ccamp |  |
| 9633 | Deterministic Networking (DetNet) YANG Data Model | detnet |  |
| 9656 | A YANG Data Model for Microwave Topology | ccamp |  |
| 9731 | A YANG Data Model for Virtual Network (VN) Operations | teas |  |

### Operations, services and VPNs

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 8049 | YANG Data Model for L3VPN Service Delivery | l3sm | obsoleted by 8299 |
| 8299 | YANG Data Model for L3VPN Service Delivery | NON WORKING GROUP |  |
| 8466 | A YANG Data Model for Layer 2 Virtual Private Network (L2VPN) Service Delivery | l2sm |  |
| 8512 | A YANG Module for Network Address Translation (NAT) and Network Prefix Translation (NPT) | opsawg |  |
| 8520 | Manufacturer Usage Description Specification | opsawg |  |
| 9105 | A YANG Data Model for Terminal Access Controller Access-Control System Plus (TACACS+) | opsawg | obsoleted by 9950 |
| 9181 | A Common YANG Data Model for Layer 2 and Layer 3 VPNs | opsawg |  |
| 9182 | A YANG Network Data Model for Layer 3 VPNs | opsawg |  |
| 9291 | A YANG Network Data Model for Layer 2 VPNs | opsawg |  |
| 9375 | A YANG Data Model for Network and VPN Service Performance Monitoring | opsawg |  |
| 9408 | A YANG Network Data Model for Service Attachment Points (SAPs) | opsawg |  |
| 9418 | A YANG Data Model for Service Assurance | opsawg |  |
| 9472 | A YANG Data Model for Reporting Software Bills of Materials (SBOMs) and Vulnerability Information | opsawg |  |
| 9833 | A Common YANG Data Model for Attachment Circuits | opsawg |  |
| 9834 | YANG Data Models for Bearers and Attachment Circuits as a Service (ACaaS) | opsawg |  |
| 9835 | A Network YANG Data Model for Attachment Circuits | opsawg |  |
| 9836 | A YANG Data Model for Augmenting VPN Service and Network Models with Attachment Circuits | opsawg |  |
| 9950 | A YANG Data Model for Terminal Access Controller Access-Control System Plus (TACACS+) | opsawg |  |
| 10065 | A YANG Data Model and RADIUS Extension for Policy-Based Network Access Control | opsawg |  |

### OAM and measurement

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 6728 | Configuration Data Model for the IP Flow Information Export (IPFIX) and Packet Sampling (PSAMP) Protocols | ipfix |  |
| 8194 | A YANG Data Model for LMAP Measurement Agents | lmap |  |
| 8531 | Generic YANG Data Model for Connection-Oriented Operations, Administration, and Maintenance (OAM) Protocols | lime |  |
| 8532 | Generic YANG Data Model for the Management of Operations, Administration, and Maintenance (OAM) Protocols That Use Connectionless Communications | lime |  |
| 8533 | A YANG Data Model for Retrieval Methods for the Management of Operations, Administration, and Maintenance (OAM) Protocols That Use Connectionless Communications | lime |  |
| 8575 | YANG Data Model for the Precision Time Protocol (PTP) | tictoc |  |
| 8913 | Two-Way Active Measurement Protocol (TWAMP) YANG Data Model | ippm |  |
| 9249 | A YANG Data Model for NTP | ntp |  |
| 9617 | A YANG Data Model for In Situ Operations, Administration, and Maintenance (IOAM) | ippm |  |

### Security, IoT and other

| RFC | Title | WG | Status |
|-----|-------|----|--------|
| 8366 | A Voucher Artifact for Bootstrapping Protocols | anima |  |
| 8513 | A YANG Data Model for Dual-Stack Lite (DS-Lite) | softwire |  |
| 8675 | A YANG Data Model for Tunnel Interface Types | softwire |  |
| 8676 | YANG Modules for IPv4-in-IPv6 Address plus Port (A+P) Softwires | softwire |  |
| 9061 | A YANG Data Model for IPsec Flow Protection Based on Software-Defined Networking (SDN) | i2nsf |  |
| 9108 | YANG Types for DNS Classes and Resource Record Types | dnsop |  |
| 9243 | A YANG Data Model for DHCPv6 Configuration | dhc |  |
| 9244 | Distributed Denial-of-Service Open Threat Signaling (DOTS) Telemetry | dots |  |
| 9348 | A YANG Data Model for IP Traffic Flow Security | ipsecme |  |
| 9349 | Definitions of Managed Objects for IP Traffic Flow Security | ipsecme |  |
| 9362 | Distributed Denial-of-Service Open Threat Signaling (DOTS) Signal Channel Configuration Attributes for Robust Block Transmission | dots |  |
| 9363 | A YANG Data Model for Static Context Header Compression (SCHC) | lpwan | updated by 9441 |
| 9441 | Static Context Header Compression (SCHC) Compound Acknowledgement (ACK) | lpwan |  |
| 9648 | YANG Data Model for TCP | tcpm |  |
| 9684 | A YANG Data Model for Challenge-Response-Based Remote Attestation (CHARRA) Procedures Using Trusted Platform Modules (TPMs) | rats |  |
| 10006 | Automatic SIP Trunking and Peering | asap |  |
