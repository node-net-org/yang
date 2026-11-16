#!/usr/bin/env bash
# Run the whole check (npm install, then npm run check) on each given Node.js line,
# each in a clean node:<line> container, and report pass or fail per line.
#   scripts/check-node.sh            # 22 24 26: every LTS line engines allows
#   scripts/check-node.sh 26         # one line
# There is no CI, so this is how a Node line is verified. It checks the working tree as it is,
# uncommitted changes included: the files git tracks or would track, never
# node_modules, build output or git-excluded files. Lines run one after another,
# so timing tests aren't starved. Logs go to $CHECK_NODE_LOGS (default: a new
# temporary directory). Each run pulls the line's current image; the npm cache is
# kept in the Docker volume nn-check-npm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINES=("$@")
[ ${#LINES[@]} -gt 0 ] || LINES=(22 24 26)
LOGS=${CHECK_NODE_LOGS:-$(mktemp -d -t check-node.XXXXXX)}
mkdir -p "$LOGS"

for line in "${LINES[@]}"; do
  [[ "$line" =~ ^[0-9]+$ ]] || { echo "check-node: not a Node.js major: $line" >&2; exit 2; }
done

# Run inside the container as root. The check itself runs as the image's
# unprivileged node user, so tests about file permissions behave as they do on
# a developer's machine.
# shellcheck disable=SC2016 # expanded inside the container
INNER='
set -euo pipefail
mkdir -p /work /home/node/.npm && cd /work
tar -x
chown -R node:node /work /home/node/.npm
as_node() { runuser -u node -- env HOME=/home/node CI=1 "$@"; }
echo "== node $(node --version), npm $(npm --version)"
as_node npm install --no-audit --no-fund
as_node npm run check
'

declare -A RESULT
for line in "${LINES[@]}"; do
  log="$LOGS/node-$line.log"
  echo "node $line: checking (log: $log)"
  start=$SECONDS
  # The working tree, minus files deleted but not yet committed.
  if (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard \
        | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
        | tar -c --null -T -) \
      | docker run --rm -i --init --pull always -v nn-check-npm:/home/node/.npm "node:$line" bash -c "$INNER" >"$log" 2>&1; then
    RESULT[$line]="pass"
  else
    RESULT[$line]="FAIL"
  fi
  echo "node $line: ${RESULT[$line]} in $(( (SECONDS - start) / 60 ))m$(( (SECONDS - start) % 60 ))s"
done

echo
failed=0
for line in "${LINES[@]}"; do
  printf '  node %-4s %s\n' "$line" "${RESULT[$line]}"
  [ "${RESULT[$line]}" = pass ] || failed=1
done
echo "logs: $LOGS"
exit "$failed"
