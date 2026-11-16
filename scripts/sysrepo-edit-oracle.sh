#!/usr/bin/env bash
# Use sysrepo (the datastore behind netopeer2) as a test oracle for the edit
# engine. sysrepo runs in a throwaway container of the netopeer2 image that
# @node-net/netconf's integration tests use, and is never a dependency of @node-net/yang.
#
# For every case in test/fixtures/edit/cases.txt it installs ed.yang, imports
# the start data into <running>, applies the edit with sysrepocfg --edit (the
# merge default operation; sysrepo validates the result), and writes to
# test/corpus/.cache/sysrepo-edit, where test/edit/oracle.test.ts finds them:
#   <case>.json       <running> after the edit, as RFC 7951 JSON
#   <case>.rejected   sysrepo's error, when it refused the edit
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
FIXTURES="$ROOT/test/fixtures/edit"
OUT="$ROOT/test/corpus/.cache/sysrepo-edit"
IMAGE=${NETOPEER2_IMAGE:-sysrepo/sysrepo-netopeer2@sha256:36cc1d841c97f118d62f775024d60fb1ce210c3bca6b32135c1a9e5a358a1cc9}
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "no $IMAGE image: docker pull it first" >&2; exit 1; }
mkdir -p "$OUT"
rm -f "$OUT"/*

docker run --rm --user 0 -v "$FIXTURES:/fixtures:ro" -v "$OUT:/out" --entrypoint bash "$IMAGE" -c '
set -u
sysrepoctl -i /fixtures/ed.yang >/dev/null
grep -v "^#" /fixtures/cases.txt | while read -r name start edit _; do
  [ -n "$name" ] || continue
  sysrepocfg --import=/fixtures/data/$start.xml -d running -m ed -f xml >/dev/null 2>&1 || { echo "$name: cannot import $start" >&2; continue; }
  if err=$(sysrepocfg --edit=/fixtures/data/$edit.xml -d running -f xml 2>&1); then
    sysrepocfg -X -d running -m ed -f json > /out/$name.json
  else
    printf "%s\n" "$err" > /out/$name.rejected
  fi
done
chown -R '"$(id -u):$(id -g)"' /out
'
echo "sysrepo edit oracle: $(ls "$OUT" | wc -l) results in $OUT"
