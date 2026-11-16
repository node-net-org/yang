#!/usr/bin/env bash
# Opt-in: install a git pre-push hook that runs `npm run check` and refuses the
# push if it fails. Nothing installs it for you.
#   scripts/install-hooks.sh              # install
#   scripts/install-hooks.sh --uninstall  # remove it
# The hook goes in the repository's shared hooks directory, so it applies to
# every worktree, and it checks the worktree being pushed from. It runs `check`,
# not `check:full`: that rule is the developer's (README, "Development").
# Skip it once with `git push --no-verify`. An existing pre-push hook that this
# script didn't write is never overwritten.
set -euo pipefail
MARK='# installed by @node-net/yang scripts/install-hooks.sh'
HOOKS="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
HOOK="$HOOKS/pre-push"

ours() { [ -f "$HOOK" ] && grep -qF "$MARK" "$HOOK"; }

case "${1:-}" in
  --uninstall)
    if ours; then rm -f "$HOOK"; echo "removed $HOOK"
    elif [ -e "$HOOK" ]; then echo "$HOOK wasn't installed by this script; left alone" >&2; exit 1
    else echo "no pre-push hook installed"; fi
    ;;
  "")
    if [ -e "$HOOK" ] && ! ours; then
      echo "$HOOK exists and wasn't installed by this script; not overwriting it" >&2
      exit 1
    fi
    mkdir -p "$HOOKS"
    cat >"$HOOK" <<EOF
#!/usr/bin/env bash
$MARK
# Runs \`npm run check\` before every push; \`git push --no-verify\` skips it once.
set -euo pipefail
cd "\$(git rev-parse --show-toplevel)"
echo "pre-push: npm run check (skip once with git push --no-verify)"
npm run check
EOF
    chmod +x "$HOOK"
    echo "installed $HOOK: every push now runs npm run check first"
    ;;
  *)
    echo "usage: $0 [--uninstall]" >&2
    exit 2
    ;;
esac
