# Instance-data fixtures

The three examples of RFC 9195 §2.2, with the RFC 8792 line folding undone.

- `acme-router-modules@2022-01-20.xml` (Figure 1) is as published. Its
  content has features written with a prefix (`sys:authentication`), which
  isn't a YANG identifier, so decoding the content reports them.
- `read-only-acm-rules@2022-01-20.xml` (Figure 2) is corrected: it writes
  `access-operation`, but RFC 8341's leaf is `access-operations`.
- `acme-router-netconf-diagnostics@2018-01-25T17_00_38Z.json` (Figure 3) is
  corrected: the published member names end in a space (`"in-sessions "`),
  and its 32-bit counters are strings where RFC 7951 §6.1 wants numbers.
