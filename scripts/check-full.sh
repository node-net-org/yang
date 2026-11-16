#!/usr/bin/env bash
# The full check: everything `npm run check` runs, plus the checks too slow for
# every landing. Run it before landing any change to dependencies, these
# scripts or the supported Node.js lines, and whenever unsure (README,
# "Development").
#   npm run check:full                      # every step (a few minutes)
#   npm run check:full -- --quick           # without the Node.js lines
#   npm run check:full -- --only ts7,check
# Steps:
#   check         npm run check, with the runtime audit required (it fails offline)
#   ts7           typecheck with TypeScript 7.0.2
#   node-lines    scripts/check-node.sh 22 24 26 (Docker; skipped by --quick)
#   audit-full    npm audit with development dependencies: reported, never fails
# Every step runs even when an earlier one failed, and a pass/FAIL line per
# step ends the run.
# The do_* functions run indirectly.
# shellcheck disable=SC2317
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ALL_STEPS=(check ts7 node-lines audit-full)
QUICK=0
ONLY=""
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check:full: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

STEPS=()
if [ -n "$ONLY" ]; then
  IFS=, read -r -a STEPS <<<"$ONLY"
  for s in "${STEPS[@]}"; do
    [[ " ${ALL_STEPS[*]} " == *" $s "* ]] || { echo "check:full: no step named '$s' (steps: ${ALL_STEPS[*]})" >&2; exit 2; }
  done
else
  STEPS=("${ALL_STEPS[@]}")
fi

LOGS=$(mktemp -d -t check-full.XXXXXX)
declare -A RESULT TIME
selected() { [[ " ${STEPS[*]} " == *" $1 "* ]]; }

# step NAME COMMAND...: run one step, logging to $LOGS/NAME.log, and record its result.
step() {
  local name=$1; shift
  local log="$LOGS/$name.log" start=$SECONDS
  echo "== $name (log: $log)"
  if "$@" >"$log" 2>&1; then RESULT[$name]=pass; else RESULT[$name]=FAIL; fi
  TIME[$name]=$((SECONDS - start))
  echo "   $name: ${RESULT[$name]} in $((TIME[$name] / 60))m$((TIME[$name] % 60))s"
  if [ "${RESULT[$name]}" = FAIL ]; then tail -n 25 "$log" | sed 's/^/   | /'; fi
}

do_check() { NN_REQUIRE_AUDIT=1 npm run check; }

do_ts7() { npx --yes -p typescript@7.0.2 tsc --noEmit -p .; }

do_node_lines() { CHECK_NODE_LOGS="$LOGS/node-lines" scripts/check-node.sh 22 24 26; }

# Reported, never failing: development advisories are for the next update.
do_audit_full() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node --input-type=module -e '
    import { npmAudit, formatCounts } from "./scripts/npm-audit.mjs";
    const r = npmAudit({ omitDev: false });
    if (r.status === "ok" || r.status === "vulnerable") {
      console.log(`${r.total} known (${formatCounts(r.counts)})`);
      for (const p of r.packages) console.log(`  ${p.severity.padEnd(9)} ${p.name}`);
    } else {
      console.log(`not run: ${r.detail}`);
    }
  '
}

total_start=$SECONDS
for s in "${ALL_STEPS[@]}"; do
  if ! selected "$s"; then continue; fi
  case $s in
    check) step check do_check ;;
    ts7) step ts7 do_ts7 ;;
    node-lines)
      if [ "$QUICK" = 1 ]; then RESULT[node-lines]="skipped (--quick)"; echo "== node-lines: skipped (--quick)"
      else step node-lines do_node_lines; fi ;;
    audit-full)
      echo "== audit-full (log: $LOGS/audit-full.log)"
      do_audit_full >"$LOGS/audit-full.log" 2>&1
      RESULT[audit-full]="report: $(head -n 1 "$LOGS/audit-full.log")" ;;
  esac
done

echo
echo "check:full summary ($(( (SECONDS - total_start) / 60 ))m$(( (SECONDS - total_start) % 60 ))s)"
failed=0
for s in "${ALL_STEPS[@]}"; do
  selected "$s" || continue
  t=""
  [ -n "${TIME[$s]:-}" ] && t=" ($((TIME[$s] / 60))m$((TIME[$s] % 60))s)"
  printf '  %-12s %s%s\n' "$s" "${RESULT[$s]}" "$t"
  [ "${RESULT[$s]}" = FAIL ] && failed=1
done
echo "logs: $LOGS"
if [ "$failed" = 1 ]; then echo "check:full: FAIL"; else echo "check:full: pass"; fi
exit "$failed"
