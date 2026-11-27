#!/usr/bin/env bash
# Usage: rust-format.sh <staged .rs file>...
# Refuses a commit when one of the given files is not formatted or does not parse. Other files in the workspace do not block.
set -euo pipefail
out=$(cargo fmt --all --check -- -l 2>&1) && exit 0
named=0
bad=()
while IFS= read -r line; do
  # rustfmt names an unformatted file by its path alone and a file that does not parse as " --> path:line:column".
  path=${line##*--> }
  path=${path%:*:*}
  [[ "$path" == *.rs ]] || continue
  named=1
  for f in "$@"; do [[ "$path" == */"$f" ]] && bad+=("$f"); done
done <<< "$out"
if [ "$named" -eq 0 ]; then
  echo "pre-commit: the Rust format check could not run:"
  printf '%s\n' "$out" | head -5
  exit 1
fi
[ "${#bad[@]}" -eq 0 ] && exit 0
echo "pre-commit: commit blocked, these files are not formatted or do not parse:"
printf '  %s\n' "${bad[@]}" | sort -u
printf '%s\n' "$out" | grep -A4 '^error' | head -10 || true
echo "Run \`cargo fmt --all\`, fix what it reports, stage the result, then commit again."
exit 1
