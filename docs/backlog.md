# @node-net/yang: backlog

Status: 2026-11-10, after M6 and the Phase 0 spike. This is the outstanding work for @node-net/yang, highest priority first, so it can be worked through top-down. Tick an item off when it lands, with the commit that did it.

It is collected from the known gaps in [rfcs.md](./rfcs.md) (one section per milestone), [net-yang-design.md](./net-yang-design.md) §13, and @node-net/netconf's integration plan (`docs/net-yang-integration-plan.md` in [node-net-org/netconf](https://github.com/node-net-org/netconf)). Those documents keep the detail; this one keeps the order.

## Done

- [x] Bring the design doc up to date with M4 to M6 (d4d7f83)
- [x] Measure compiling a vendor-scale module set: Nokia SR OS 26.10, 229 modules, 2.4 s, 306 MB (d4d7f83; integration plan, "Phase 0 spike")
- [x] Decide whether compiled schemas are cached: no, cache module text and compile once per process (d4d7f83)
- [x] Skip leafrefs, keys and defaults inside subtrees removed by `deviate not-supported`, found by the spike (d4d7f83)
- [x] Let a schema drop its statement trees: released by default, `keepStatements` keeps them. SR OS keeps 121 MB rather than 306 MB (0bfa9d7)
- [x] Bound regex matching time: patterns are matched by a linear-time automaton, not a backtracking RegExp. SR OS's worst pattern went from 2 s on 29 characters to under 1 ms on 100,000 (7a8602e)
- [x] Check leafref predicates: each predicate's key and `current()/..` path are resolved against the schema at compile time, as libyang does. Validation already applied them; yanglint cases now pin several predicates and `current()/../..` paths (2e7a5ad)
- [x] Line and column numbers on data issues: with the `positions` decode option, issues from XML or JSON text, and from validating the tree later, carry the line and column. Opt-in, since it adds about 40 MB to a 140 MB tree. Needed for nnc's offline `validate <file>` (use case 17) (499460a)
- [x] `continue-on-error` and `stop-on-error` for edits: `tryApplyEdit` with `errorOption`, returning the partial result with its errors, for the schema-aware mock server (use case 18) (6f8413a)
- [x] `ietf-origin` in edits and diffs of `<operational>`: diffs report a change to a node's effective origin (its own `or:origin` or its nearest ancestor's), compared by identity, and edits keep at most one origin per node, dropped where it equals the inherited one. `effectiveOrigin` reads it, for `origin-filter` and the mock server (use case 18) (42e26b0)
- [x] anydata and anyxml in diffs and edits: diffs report a `replace` only when the content means something different, ignoring JSON member order, prefixes, whitespace between elements and the order of differently named anydata siblings, and comparing XML with JSON. Edits keep replacing the content whole, as RFC 7950 §7.10.3 requires, with `nc:operation` inside it kept as data, and leave content that means the same as it was (2236b17)
- [x] Mandatory nodes in default cases and in augments of another module: errors, as in libyang, checked after refines and deviations. A YANG 1.1 augment may add them under its own `when`; a YANG 1.0 one with `when` gets a warning, as RFC 6020 has no exception but libyang allows it. No IETF, OpenConfig, SR OS 26.10 or netopeer2 module breaks either rule; @node-net/yang rejects the same 35 fixture modules as yanglint (a2306a7)
- [x] Analyse XPath against the schema: the paths in `must` and `when` are followed through the compiled tree from their context nodes, within the accessible tree, and a step that can select nothing is a warning (`xpath-unknown-node`, `xpath-state-from-config`, `xpath-not-implemented`), as are `when` conditions that depend on each other (`when-cycle`; libyang rejects them). It gives up rather than risk a false warning. 13 statements in the IETF, OpenConfig and SR OS 26.10 sets, all genuine and all warned about by yanglint; about 20 ms on SR OS (37f6c5b)
- [x] YANG 1.0's narrower submodule visibility: a YANG 1.0 module or submodule that refers to a typedef, grouping, identity, feature or extension in a file it doesn't include, or a submodule that refers to its main module's, gets a warning that names the include to add (`definition-not-included`). The definition is still used, as libyang uses it. A module including a submodule of the other YANG version gets a warning too (`include-version-mismatch`). pyang rejects the same 1.0 layouts; yanglint accepts them all. No IETF, OpenConfig, SR OS 26.10 or netopeer2 module is warned about (f2eb996)
- [x] `status` references: a definition that refers to a less current one (by effective status, inherited from enclosing statements) gets a warning, `status-reference` within a module (an RFC 7950 MUST, which libyang and pyang reject) or `status-reference-other-module` across modules. It covers typedefs, groupings, identities, features, leafref and augment targets, and the nodes `must` and `when` select. Groupings are checked once, where defined. IETF has 2 and OpenConfig 3, all across modules; SR OS 26.10 and netopeer2 none (df825ba)
- [x] Check values of type `yang:xpath1.0`, such as NACM's `path`: values of the typedef and of typedefs derived from it are checked as XPath when read (syntax, prefixes, functions and their argument counts; variables allowed, names not looked up), held with module names as prefixes as libyang holds them, and written with namespace prefixes in XML (ed3692d)
- [x] Key values holding both quote characters: data paths write them as `concat()`, which @node-net/yang's and @node-net/netconf's path readers read back, and `diffEdit` refuses (`unwritable-anchor`) to put one in `yang:key`, since libyang refuses `concat()` there (ed3692d)
- [x] Filters for reads: `subtreeFilter` (RFC 6241 §6, with §6.2.5's sibling rules, typed content matches and attribute matches), `selectionTree` for `:xpath` filter replies (§8.9), and `pruneTree` for `<get-data>`'s `max-depth` and `config-filter` (RFC 8526 §3.1.1), for @node-net/netconf-server's M1
- [x] `mergeTrees`: merge data trees, configuration and state, as `<operational>` and `<get>` combine them, for @node-net/netconf-server's M1
- [x] `writeYang`: statement trees written as YANG text that reads back to the same tree (every corpus module and pyang's YIN round-trips), for YIN-sourced modules in @node-net/netconf-server's `<get-schema>`

## 1. Before @node-net/netconf relies on @node-net/yang

These gate Phase 1 and Phase 2 of the integration plan.

- [ ] **Settle the API.** Review the exports in `src/index.ts` before glue code is written against them. (Publishing is settled: @node-net/yang is 0.1.0 and is published before @node-net/netconf, which `prepublishOnly` enforces; see `docs/cli.md` §2.2.)

## 2. Correctness gaps the integration phases will hit

- [ ] **Unicode block escapes in patterns** (`\p{IsBasicLatin}`). A module that uses one is rejected. None in IETF, OpenConfig or SR OS so far, so this moves up only when a module set needs it.
- [ ] **A path-based API for building trees.** Needed for `txn.set(path, value)` (use case 6, Phase 4). Nodes are created and appended by hand today.

## 3. Compiler checks

Lint-level: a server catches these anyway.

Nothing left: further rules belong to the lint mode (section 5).

## 4. Low priority, already known

- [ ] Make annotations visible to XPath (the attribute axis), and make `id()` and `lang()` work.
- [ ] Deviations of nodes inside structures, and `sx:augment-structure` of a yang-data.
- [ ] Decode anydata against the schema; make converting anyxml between XML and JSON less lossy.
- [ ] Streaming decode, rather than whole documents. Moves up if full device configs prove too big.
- [ ] More speed, if it is ever needed: reading text (lexer, parser, grammar check) is about 60% of a compile, with no single hotspot left (`scripts/compile-benchmark.mjs` measures it).

## 5. Later milestones (P2 in rfcs.md)

- [ ] Schema mount (RFC 8528): logical systems and network instances on some vendors.
- [ ] Lint mode (RFC 9907, the `pyang --ietf` rules). The checks in section 3 would be its first rules.
- [ ] Schema comparison (draft-ietf-netmod-yang-schema-comparison): diffs between device releases.
- [ ] Module versioning and YANG packages (netmod drafts): watch, and implement when adopted.
- [ ] YANG-CBOR and SID files (RFC 9254, 9595): only for CORECONF.
- [ ] YANG 2.0 (draft-ietf-netmod-yang2): mostly new grammar table entries.

## Not @node-net/yang's

Recorded so they aren't looked for here.

- Out of scope by decision: DSDL (RFC 6110), SMIv2 (RFC 6643), NACM enforcement, and anything protocol-specific.
- In @node-net/netconf: YANG Patch payloads (built from `DataChange`s), mapping edit issue codes to NETCONF error-tags, the `<get-schema>` module source and the disk cache.
- To check on devices: whether SR OS offers `<get-schema>` (the 7210 SAS test router doesn't, and Nokia publishes no 7210 modules, so a 7210 needs a device profile bundle).
