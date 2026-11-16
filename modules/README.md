# Bundled modules

IETF modules that most other modules import, bundled so that `builtinSource`
can resolve them without network or filesystem access. Each file is copied
unchanged from the RFC that publishes it (via the YangModels/yang repository),
and is named `name@revision.yang`.

| Module | Revisions | RFC |
|--------|-----------|-----|
| ietf-yang-types | 2010-09-24, 2013-07-15, 2025-12-22 | 6021, 6991, 9911 |
| ietf-inet-types | 2010-09-24, 2013-07-15, 2025-12-22 | 6021, 6991, 9911 |
| ietf-yang-metadata | 2016-08-05 | 7952 |
| ietf-yang-structure-ext | 2020-06-17 | 8791 |
| ietf-datastores | 2018-02-14 | 8342 |
| ietf-origin | 2018-02-14 | 8342 |
| ietf-yang-library | 2019-01-04 | 8525 |
| ietf-yang-library-augmentedby | 2026-08-26 | 10035 |
| ietf-yang-instance-data | 2022-02-17 | 9195 |
| ietf-restconf | 2017-01-26 | 8040 |
| ietf-netconf-acm | 2018-02-14 | 8341 |
| ietf-netconf | 2011-06-01 | 6241 |
| ietf-netconf-with-defaults | 2011-06-01 | 6243 |

These modules are code components of IETF documents. They are licensed under
the Simplified BSD License set forth in Section 4.c of the IETF Trust's Legal
Provisions Relating to IETF Documents (https://trustee.ietf.org/license-info),
as each module's own description states.
