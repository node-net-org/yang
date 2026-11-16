#!/usr/bin/env bash
# Use pyang as a test oracle for the corpus fetched by scripts/fetch-corpus.sh.
# pyang runs in a throwaway container and is never a dependency of @node-net/yang.
# Writes to test/corpus/.cache, where test/corpus.test.ts finds them:
#   pyang-statements.json        every file's statement tree (the parser)
#   pyang-tree-ietf.json         compiled trees of all IETF RFC modules at once
#   pyang-tree-openconfig.json   compiled trees of all OpenConfig modules at once
#   pyang-yin/                   every file as YIN (pyang -f yin), for the YIN parser
#   pyang-tree-ietf.txt          tree diagrams (pyang -f tree) of all IETF RFC modules at once
#   pyang-tree-ietf-69.txt       the same, folded at 69 columns (--tree-line-length 69)
#   pyang-xpath/<case>.ok|.error  pyang's verdict on each module in test/fixtures/xpath
#   pyang-mandatory/<case>.ok|.error  pyang's verdict on each module in test/fixtures/mandatory, with mn-base
#   pyang-xpath-schema/<case>.ok|.warn|.error  the same for test/fixtures/xpath-schema, with xs-base: .warn
#                                when pyang warns that an XPath node is not found or not accessible
#   pyang-submodule-visibility/<case>.ok|.error  pyang's verdict on module m of each layout in
#                                test/fixtures/submodule-visibility
#   pyang-status/<case>.ok|.error  pyang's verdict on each module in test/fixtures/status, with st-base
set -euo pipefail
PYANG_VERSION=${PYANG_VERSION:-2.7.1}
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/../test/corpus/.cache"
[ -d "$CACHE" ] || { echo "no corpus: run scripts/fetch-corpus.sh first" >&2; exit 1; }
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$CACHE:/corpus" -v "$HERE:/scripts:ro" -v "$HERE/../test/fixtures/xpath:/xpath:ro" \
  -v "$HERE/../test/fixtures/mandatory:/mandatory:ro" -v "$HERE/../test/fixtures/xpath-schema:/xpath-schema:ro" \
  -v "$HERE/../test/fixtures/submodule-visibility:/submodule-visibility:ro" -v "$HERE/../test/fixtures/status:/status:ro" \
  python:3.12-slim sh -c "
set -e
pip install --quiet --user --disable-pip-version-check pyang==$PYANG_VERSION
export PATH=/tmp/.local/bin:\$PATH
python -P /scripts/pyang-statements.py /corpus /corpus/pyang-statements.json
rm -rf /corpus/pyang-yin
python -P /scripts/pyang-statements.py --yin /corpus/pyang-yin /corpus
IETF=/corpus/yangmodels/standard/ietf/RFC
IANA=/corpus/yangmodels/standard/iana
IEEE=\$(find /corpus/yangmodels/standard/ieee/published -type d | tr '\n' ':')
OC=\$(find /corpus/openconfig/release/models -type d | tr '\n' ':')
# The latest revision of every module (not submodule), by its undated file name.
latest() { for f in \$(find \"\$1\" -name '*.yang' ! -name '*@*' | sort); do grep -q '^module ' \"\$f\" && echo \"\$f\"; done; }
pyang --plugindir /scripts/pyang-plugin -f nn-tree --ignore-errors -p \$IETF:\$IANA:\$IEEE \$(latest \$IETF) > /corpus/pyang-tree-ietf.json 2>/dev/null || true
pyang --plugindir /scripts/pyang-plugin -f nn-tree --ignore-errors -p \$OC\$IETF:\$IANA \$(latest /corpus/openconfig/release/models) > /corpus/pyang-tree-openconfig.json 2>/dev/null || true
TREE='--tree-print-structures --tree-print-yang-data'
pyang -f tree \$TREE --ignore-errors -p \$IETF:\$IANA:\$IEEE \$(latest \$IETF) > /corpus/pyang-tree-ietf.txt 2>/dev/null || true
pyang -f tree \$TREE --tree-line-length 69 --ignore-errors -p \$IETF:\$IANA:\$IEEE \$(latest \$IETF) > /corpus/pyang-tree-ietf-69.txt 2>/dev/null || true
# XPath in must, when and path: one fixture module per case.
rm -rf /corpus/pyang-xpath && mkdir -p /corpus/pyang-xpath
for f in /xpath/xp-*.yang; do
  c=\$(basename \$f .yang); c=\${c#xp-}
  if pyang -p \$IETF:\$IANA \$f > /corpus/pyang-xpath/\$c.out 2>&1 && ! grep -q ': error:' /corpus/pyang-xpath/\$c.out; then
    mv /corpus/pyang-xpath/\$c.out /corpus/pyang-xpath/\$c.ok
  else
    mv /corpus/pyang-xpath/\$c.out /corpus/pyang-xpath/\$c.error
  fi
done
# Mandatory nodes in augments and default cases: one fixture module per case, with mn-base.
rm -rf /corpus/pyang-mandatory && mkdir -p /corpus/pyang-mandatory
for f in /mandatory/mn-*.yang; do
  c=\$(basename \$f .yang); c=\${c#mn-}
  [ \$c = base ] && continue
  if pyang -p /mandatory /mandatory/mn-base.yang \$f > /corpus/pyang-mandatory/\$c.out 2>&1 && ! grep -q ': error:' /corpus/pyang-mandatory/\$c.out; then
    mv /corpus/pyang-mandatory/\$c.out /corpus/pyang-mandatory/\$c.ok
  else
    mv /corpus/pyang-mandatory/\$c.out /corpus/pyang-mandatory/\$c.error
  fi
done
# YANG 1.0 submodule visibility: one directory per case, compiling its module m.
rm -rf /corpus/pyang-submodule-visibility && mkdir -p /corpus/pyang-submodule-visibility
for d in /submodule-visibility/*/; do
  c=\$(basename \$d)
  o=/corpus/pyang-submodule-visibility/\$c.out
  if (cd \$d && pyang -p . m.yang) > \$o 2>&1 && ! grep -q ': error:' \$o; then mv \$o \${o%.out}.ok; else mv \$o \${o%.out}.error; fi
done
# Paths in must and when followed through the schema: one fixture module per case, with xs-base.
rm -rf /corpus/pyang-xpath-schema && mkdir -p /corpus/pyang-xpath-schema
for f in /xpath-schema/xs-*.yang; do
  c=\$(basename \$f .yang); c=\${c#xs-}
  case \$c in base|other) continue ;; esac
  o=/corpus/pyang-xpath-schema/\$c.out
  if pyang -p /xpath-schema /xpath-schema/xs-base.yang \$f > \$o 2>&1 && ! grep -q ': error:' \$o; then
    if grep -q -e 'is not found' -e 'not part of the accessible tree' \$o; then mv \$o \${o%.out}.warn; else mv \$o \${o%.out}.ok; fi
  else
    mv \$o \${o%.out}.error
  fi
done
# References to less current definitions: one fixture module per case, with st-base.
rm -rf /corpus/pyang-status && mkdir -p /corpus/pyang-status
for f in /status/st-*.yang; do
  c=\$(basename \$f .yang); c=\${c#st-}
  [ \$c = base ] && continue
  o=/corpus/pyang-status/\$c.out
  if pyang -p /status /status/st-base.yang \$f > \$o 2>&1 && ! grep -q ': error:' \$o; then mv \$o \${o%.out}.ok; else mv \$o \${o%.out}.error; fi
done
echo done
"
ls -la "$CACHE"/pyang-*.json "$CACHE"/pyang-tree-*.txt
