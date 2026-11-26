#!/usr/bin/env bash
# Usage: push-typecheck.sh <remote name> <remote url>, with git's pre-push lines on stdin.
# Type-checks the app and the keeper before a push to GitHub, where every branch gets a Vercel build.
# Pushes to other remotes (the build server) are not checked.
set -euo pipefail
remote=$1
case "$2" in *github.com*) ;; *) exit 0 ;; esac

zero=0000000000000000000000000000000000000000
head=$(git rev-parse HEAD)
app=0
keeper=0
touches() { ! git cat-file -e "$1^{commit}" 2>/dev/null || ! git diff --quiet "$1" "$2" -- "$3"; }
while read -r ref sha _ remote_sha; do
  [ "$sha" = "$zero" ] && continue
  base=$remote_sha
  [ "$base" = "$zero" ] && base=$(git merge-base "$sha" "refs/remotes/$remote/main" 2>/dev/null || echo "$zero")
  ref_app=0
  ref_keeper=0
  touches "$base" "$sha" app && ref_app=1
  touches "$base" "$sha" keeper && ref_keeper=1
  if [ "$ref_app$ref_keeper" != 00 ] && [ "$sha" != "$head" ]; then
    echo "pre-push: push blocked, $ref is not the checked-out commit, so its types cannot be checked from here. Push it from its own worktree."
    exit 1
  fi
  [ "$ref_app" -eq 1 ] && app=1
  [ "$ref_keeper" -eq 1 ] && keeper=1
done
[ "$app$keeper" = 00 ] && exit 0

if [ ! -d app/node_modules ] || [ ! -d keeper/node_modules ]; then
  echo "pre-push: cannot type-check, node_modules is missing. Run \`pnpm install --frozen-lockfile\` at the repo root, then push again."
  exit 1
fi

# The app's type check holds about 2.2 GB. In its own capped scope, a machine short of memory kills the check, not the terminal.
scope=()
systemd-run --user --scope -q -- true 2>/dev/null && scope=(systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 --)
typecheck() {
  "${scope[@]}" pnpm --filter "@tesoro/$1" typecheck < /dev/null && return 0
  echo "pre-push: push blocked, the $1 does not type-check. Fix the errors above, commit, then push again. A check that was killed with no errors listed ran out of memory: free about 2.2 GB and push again."
  exit 1
}
[ "$app" -eq 1 ] && typecheck app
typecheck keeper
