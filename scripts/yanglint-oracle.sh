#!/usr/bin/env bash
# Use yanglint (libyang) as a test oracle for the XML and JSON codecs.
# yanglint runs in a throwaway container (Debian bookworm's libyang2-tools)
# and is never a dependency of @node-net/yang.
#
# For every case in test/fixtures/oracle/cases.txt it writes, to
# test/corpus/.cache/yanglint, where test/oracle.test.ts finds them:
#   <case>.xml            the input re-printed as XML (canonical values, schema order)
#   <case>.json           the input converted to RFC 7951 JSON
#   <case>.from-json.xml  that JSON converted back to XML
# and for every input in test/fixtures/oracle/invalid.txt, which yanglint
# should refuse:
#   invalid-<input>.rejected   yanglint's error message (or .accepted if it took it)
# and for every with-defaults case in test/fixtures/oracle/defaults.txt:
#   <case>.xml            the data as yanglint -d <mode> prints it
# and for every YANG library in test/fixtures/library/*.xml that has a
# yang-library container (libyang needs one; it ignores modules-state):
#   library-<name>.json   the context yanglint -Y builds, as YANG library data
# and for every validation case in test/fixtures/validate/cases.txt:
#   validate-<case>.ok | validate-<case>.rejected   yanglint's verdict, with its error
# and for every module in test/fixtures/xpath (one XPath or leafref path problem each, or none):
#   xpath/<case>.ok | xpath/<case>.error   yanglint's verdict on compiling it
# and for every module in test/fixtures/mandatory (mandatory nodes in augments and default cases):
#   mandatory/<case>.ok | mandatory/<case>.error   yanglint's verdict on compiling it with mn-base
# and for every module in test/fixtures/xpath-schema (paths in must and when, followed through the schema):
#   xpath-schema/<case>.ok | .warn | .error   whether yanglint accepts it with xs-base, warns about
#   a schema node not found (or a module not implemented), or rejects it; the file holds its messages
# and for every layout in test/fixtures/submodule-visibility (YANG 1.0 submodule visibility):
#   submodule-visibility/<case>.ok | .error   yanglint's verdict on compiling its module m, with its messages
# and for every module in test/fixtures/status (references to less current definitions):
#   status/<case>.ok | .warn | .error   whether yanglint accepts it with st-base, warns that it
#                         may be referencing a deprecated node, or rejects it; with its messages
# and for 400 random documents over the same module (scripts/validate-samples.mjs),
# in test/corpus/.cache/validate-samples:
#   sample-<n>.ok | sample-<n>.rejected   the same
# The IETF and IANA modules come from the corpus (scripts/fetch-corpus.sh).
#
# When the netopeer2 image (the one @node-net/netconf's integration tests use) is
# present, a real server's YANG library is taken from a throwaway container,
# with its module files, into test/corpus/.cache/netopeer2, and yanglint -Y
# builds a context from it too:
#   library-netopeer2.json
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
CACHE="$ROOT/test/corpus/.cache"
FIXTURES="$ROOT/test/fixtures/oracle"
OUT="$CACHE/yanglint"
IMAGE=net-yang-yanglint:bookworm
[ -d "$CACHE/yangmodels" ] || { echo "no corpus: run scripts/fetch-corpus.sh first" >&2; exit 1; }
mkdir -p "$OUT"
rm -rf "$OUT"/*
SAMPLES="$CACHE/validate-samples"
rm -rf "$SAMPLES"
node "$HERE/validate-samples.mjs" "$SAMPLES" 400

# A small local image, so libyang2-tools is installed once rather than per run.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" - <<'EOF'
FROM debian:bookworm
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libyang2-tools >/dev/null && rm -rf /var/lib/apt/lists/*
EOF
fi

NP="$CACHE/netopeer2"
NP_IMAGE=${NETOPEER2_IMAGE:-sysrepo/sysrepo-netopeer2@sha256:36cc1d841c97f118d62f775024d60fb1ce210c3bca6b32135c1a9e5a358a1cc9}
if docker image inspect "$NP_IMAGE" >/dev/null 2>&1; then
  rm -rf "$NP" && mkdir -p "$NP/yang"
  docker run --rm --user 0 -v "$NP:/np" --entrypoint sh "$NP_IMAGE" -c "
set -e
sysrepocfg -X -d operational -x '/ietf-yang-library:*' -f json > /np/yang-library.json
cp /usr/share/yang/modules/libyang/*.yang /np/yang/ && cp -f /etc/sysrepo/yang/*.yang /np/yang/
chown -R $(id -u):$(id -g) /np"
  echo "netopeer2: $(ls "$NP/yang" | wc -l) modules"
fi
mkdir -p "$NP"

docker run --rm --user "$(id -u):$(id -g)" \
  -v "$CACHE/yangmodels/standard:/std:ro" -v "$FIXTURES:/fx:ro" -v "$ROOT/test/fixtures/library:/yl:ro" -v "$NP:/np:ro" -v "$OUT:/out" \
  -v "$ROOT/test/fixtures/validate:/vf:ro" -v "$SAMPLES:/samples" -v "$ROOT/test/fixtures/xpath:/xp:ro" \
  -v "$ROOT/test/fixtures/mandatory:/mn:ro" -v "$ROOT/test/fixtures/xpath-schema:/xs:ro" \
  -v "$ROOT/test/fixtures/submodule-visibility:/sv:ro" -v "$ROOT/test/fixtures/status:/st:ro" \
  "$IMAGE" sh -c '
set -u
yanglint --version
# The file of a module: a fixture, the undated RFC file, or the latest dated one.
file() {
  for f in /fx/$1.yang /std/ietf/RFC/$1.yang; do [ -f "$f" ] && { echo "$f"; return; }; done
  ls /std/ietf/RFC/$1@*.yang /std/iana/$1@*.yang 2>/dev/null | sort | tail -n 1
}
grep -v "^#" /fx/cases.txt | while read -r name type input modules; do
  [ -n "$name" ] || continue
  files=""
  for m in $modules; do files="$files $(file "$m")"; done
  lint() { yanglint -p /fx -p /std/ietf/RFC -p /std/iana -t "$type" "$@"; }
  if lint -f xml $files "/fx/data/$input" > "/out/$name.xml" 2> "/out/$name.err" &&
     lint -f json $files "/fx/data/$input" > "/out/$name.json" 2>> "/out/$name.err" &&
     lint -f xml $files "/out/$name.json" > "/out/$name.from-json.xml" 2>> "/out/$name.err"; then
    echo "ok   $name"
  else
    echo "FAIL $name: $(cat "/out/$name.err")"
  fi
done
IF="$(file ietf-interfaces) $(file ietf-ip) $(file iana-if-type)"
grep -v "^#" /fx/invalid.txt | while read -r input code path; do
  [ -n "$input" ] || continue
  if yanglint -p /std/ietf/RFC -p /std/iana -t get -f json $IF "/fx/invalid/$input" > /dev/null 2> "/out/invalid-$input.rejected"; then
    mv "/out/invalid-$input.rejected" "/out/invalid-$input.accepted"
    echo "ACCEPTED $input"
  else
    echo "rejected $input: $(head -n 1 "/out/invalid-$input.rejected")"
  fi
done
WD="/fx/ex-wd.yang $(file ietf-netconf-with-defaults)"
grep -v "^#" /fx/defaults.txt | while read -r name mode input; do
  [ -n "$name" ] || continue
  d=""; [ "$mode" = explicit ] || d="-d $mode"
  if yanglint -p /std/ietf/RFC -t data $d -f xml $WD "/fx/data/$input" > "/out/$name.xml" 2> "/out/$name.err"; then
    echo "ok   $name"
  else
    echo "FAIL $name: $(cat "/out/$name.err")"
  fi
done
# Validation: accept or reject, and the first error with its path.
grep -v "^#" /vf/cases.txt | while read -r name type input op code path; do
  [ -n "$name" ] || continue
  O=""; [ "$op" = "-" ] || O="-O /vf/data/$op"
  modules=/vf/vx.yang; [ -f "/vf/data/$name.modules" ] && modules=$(cat "/vf/data/$name.modules")
  if yanglint -p /vf -p /std/ietf/RFC -p /std/iana -t "$type" $O $modules "/vf/data/$input" > /dev/null 2> "/out/validate-$name.rejected"; then
    mv "/out/validate-$name.rejected" "/out/validate-$name.ok"
    echo "accepted $name"
  else
    echo "rejected $name: $(head -n 1 "/out/validate-$name.rejected")"
  fi
done
# Compile checks: one module per case.
mkdir -p /out/xpath
for f in /xp/xp-*.yang; do
  c=$(basename "$f" .yang); c=${c#xp-}
  if yanglint -p /std/ietf/RFC -p /std/iana "$f" > /dev/null 2> "/out/xpath/$c.error"; then
    mv "/out/xpath/$c.error" "/out/xpath/$c.ok"
  fi
done
echo "xpath: $(ls /out/xpath/*.ok | wc -l) accepted, $(ls /out/xpath/*.error | wc -l) rejected"
mkdir -p /out/mandatory
for f in /mn/mn-*.yang; do
  c=$(basename "$f" .yang); c=${c#mn-}
  [ "$c" = base ] && continue
  if yanglint -p /mn /mn/mn-base.yang "$f" > /dev/null 2> "/out/mandatory/$c.error"; then
    mv "/out/mandatory/$c.error" "/out/mandatory/$c.ok"
  fi
done
echo "mandatory: $(ls /out/mandatory/*.ok | wc -l) accepted, $(ls /out/mandatory/*.error | wc -l) rejected"
mkdir -p /out/xpath-schema
for f in /xs/xs-*.yang; do
  c=$(basename "$f" .yang); c=${c#xs-}
  case "$c" in base|other) continue ;; esac
  if yanglint -p /xs /xs/xs-base.yang "$f" > /dev/null 2> "/out/xpath-schema/$c.out"; then
    if grep -q -e "not found" -e "not implemented" "/out/xpath-schema/$c.out"; then v=warn; else v=ok; fi
  else
    v=error
  fi
  mv "/out/xpath-schema/$c.out" "/out/xpath-schema/$c.$v"
done
echo "xpath-schema: $(ls /out/xpath-schema/*.ok | wc -l) clean, $(ls /out/xpath-schema/*.warn | wc -l) warned, $(ls /out/xpath-schema/*.error | wc -l) rejected"
mkdir -p /out/submodule-visibility
for d in /sv/*/; do
  c=$(basename "$d")
  if yanglint -p "$d" "$d/m.yang" > /dev/null 2> "/out/submodule-visibility/$c.out"; then v=ok; else v=error; fi
  mv "/out/submodule-visibility/$c.out" "/out/submodule-visibility/$c.$v"
done
echo "submodule-visibility: $(ls /out/submodule-visibility/*.ok | wc -l) accepted, $(ls /out/submodule-visibility/*.error 2>/dev/null | wc -l) rejected"
rm -rf /out/status && mkdir -p /out/status
for f in /st/st-*.yang; do
  c=$(basename "$f" .yang); c=${c#st-}
  [ "$c" = base ] && continue
  if yanglint -p /st /st/st-base.yang "$f" > /dev/null 2> "/out/status/$c.out"; then
    if grep -q "may be referencing deprecated" "/out/status/$c.out"; then v=warn; else v=ok; fi
  else
    v=error
  fi
  mv "/out/status/$c.out" "/out/status/$c.$v"
done
echo "status: $(ls /out/status/*.ok | wc -l) clean, $(ls /out/status/*.warn | wc -l) warned, $(ls /out/status/*.error | wc -l) rejected"
for f in /samples/sample-*.json; do
  s=${f%.json}
  if yanglint -t data /vf/vx.yang "$f" > /dev/null 2> "$s.rejected"; then mv "$s.rejected" "$s.ok"; fi
done
echo "samples: $(ls /samples/*.ok | wc -l) accepted, $(ls /samples/*.rejected | wc -l) rejected"
# YANG library contexts, from exactly the module files yl/modules.txt names.
mkdir -p /tmp/libmods
grep -v "^#" /yl/modules.txt | while read -r f; do [ -n "$f" ] && cp "/std/$f" /tmp/libmods/; done
cp /yl/*.yang /tmp/libmods/
for f in /yl/*.xml; do
  grep -q "<yang-library" "$f" || continue
  name=$(basename "$f" .xml)
  if (cd /tmp && yanglint -D -Y "$f" -p /tmp/libmods -l -f json) > "/out/library-$name.json" 2> "/out/library-$name.err"; then
    echo "ok   library $name"
  else
    echo "FAIL library $name: $(cat "/out/library-$name.err")"
  fi
done
if [ -f /np/yang-library.json ]; then
  if (cd /tmp && yanglint -D -Y /np/yang-library.json -p /np/yang -l -f json) > /out/library-netopeer2.json 2> /out/library-netopeer2.err; then
    echo "ok   library netopeer2"
  else
    echo "FAIL library netopeer2: $(cat /out/library-netopeer2.err)"
  fi
fi
'
ls "$OUT"
