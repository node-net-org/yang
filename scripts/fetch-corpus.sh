#!/usr/bin/env bash
# Fetch the public YANG module corpus used by test/corpus.test.ts into
# test/corpus/.cache (git-ignored). Shallow, sparse clones only:
#   ietf        YangModels/yang standard/ietf/RFC (every module published in an RFC)
#   openconfig  openconfig/public release/models
#   iana        YangModels/yang standard/iana
#   ieee        YangModels/yang standard/ieee/published (imported by some IETF modules)
#   nokia       nokia/7x50_YangModels, one SR OS release (NOKIA_RELEASE, default
#               latest_sros_26.10): a vendor-scale set, nokia-conf alone is 22 MB.
#               Nokia's licence (SROS-YANG-LICENSE.txt) only allows unmodified
#               copies with its notice, so it is fetched, never committed.
# Re-running updates the clones. The corpus test skips any set that is missing.
set -euo pipefail
CACHE="$(cd "$(dirname "$0")/.." && pwd)/test/corpus/.cache"
mkdir -p "$CACHE"

sparse() { # name url path...
  local dir="$CACHE/$1" url=$2; shift 2
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --quiet --depth 1
  else
    git clone --quiet --depth 1 --filter=blob:none --sparse "$url" "$dir"
  fi
  git -C "$dir" sparse-checkout set "$@"
  echo "$(git -C "$dir" rev-parse --short HEAD)  $url ($*)"
}

sparse yangmodels https://github.com/YangModels/yang.git standard/ietf/RFC standard/iana standard/ieee/published
sparse openconfig https://github.com/openconfig/public.git release/models
sparse nokia https://github.com/nokia/7x50_YangModels.git "${NOKIA_RELEASE:-latest_sros_26.10}"
