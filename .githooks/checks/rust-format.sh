#!/usr/bin/env bash
# Usage: rust-format.sh <staged .rs file>...
# Refuses a commit whose staged Rust is not formatted. Files another session left unformatted do not block.
set -euo pipefail
out=$(cargo fmt --all --check -- -l 2>&1) && exit 0
unformatted=()
listed=0
while IFS= read -r line; do
  [ -f "$line" ] || continue
  listed=1
  for f in "$@"; do [[ "$line" == */"$f" ]] && unformatted+=("$f"); done
done <<< "$out"
if [ "$listed" -eq 0 ]; then
  echo "pre-commit: the Rust format check could not run:"
  printf '%s\n' "$out" | head -5
  exit 1
fi
[ "${#unformatted[@]}" -eq 0 ] && exit 0
echo "pre-commit: commit blocked, these files are not formatted:"
printf '  %s\n' "${unformatted[@]}"
echo "Run \`cargo fmt --all\`, stage the result, then commit again."
exit 1
