#!/usr/bin/env bash
# Makes a private copy of the SBF SDK that ships next to cargo-build-sbf, with its platform tools pinned to one
# directory, for a build with `--sbf-sdk <copy>`. The SDK's scripts/install.sh (run by env.sh, which strip.sh
# sources after every program build) re-points `dependencies/platform-tools` to its built-in version AND re-links the
# machine-wide `solana` rustup toolchain whenever its marker files are missing, so the copy carries the markers and
# the criterion link too; scripts/test-check-sbf-toolchain.py runs that install.sh against a copy to prove it stays idle.
# usage: sbf-private-sdk.sh <platform-tools dir> <destination dir>
set -euo pipefail
tools=$1
dest=$2
src="$(dirname "$(readlink -f "$(command -v cargo-build-sbf)")")/platform-tools-sdk/sbf"
[ -f "$src/scripts/install.sh" ] || { echo "error: no SBF SDK at $src (is cargo-build-sbf on PATH?)" >&2; exit 1; }
mkdir -p "$dest/dependencies"
cp -r "$src/c" "$src/scripts" "$src/env.sh" "$src/syscalls.txt" "$dest/"
ln -s "$tools" "$dest/dependencies/platform-tools"
for marker in "$src"/dependencies/*.md; do
  [ -e "$marker" ] && cp "$marker" "$dest/dependencies/"
done
if [ -e "$src/dependencies/criterion" ]; then
  ln -s "$(readlink -f "$src/dependencies/criterion")" "$dest/dependencies/criterion"
fi
[ -f "$dest/dependencies/platform-tools-v1.48.md" ] || {
  echo "error: $src/dependencies has no platform-tools marker; the SDK has never run and its install.sh would re-link the shared solana toolchain. Run one plain \`cargo build-sbf --tools-version v1.54\` first." >&2
  exit 1
}
