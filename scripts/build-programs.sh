#!/usr/bin/env bash
# Builds all Solana programs and their IDLs.
# Anchor's default platform tools ship Cargo 1.84, which cannot parse edition-2024 crates in the
# current dependency tree, so programs build with platform tools v1.54 and IDLs build separately.
# The tools are pinned by path: an SBF build normally resolves rustc through the one `solana` rustup toolchain, which
# every SBF build on the machine re-points to its own tools version, so a concurrent v1.52 build in another project
# swaps the compiler under this one (scripts/check-sbf-toolchain.py has the story). Here the compiler runs from its
# own directory, nothing shared is read or written, and every rustc run is logged and checked.
# --throwaway-keys: for CI-style test builds only. Skips the deploy-key copy, so anchor makes fresh program keypairs; the
# .so files and IDLs it writes are NOT FOR DEPLOY. Without the flag a missing deploy-keys folder is an error.
set -euo pipefail
throwaway=0
for arg in "$@"; do
  case "$arg" in
    --throwaway-keys) throwaway=1 ;;
    *) echo "usage: build-programs.sh [--throwaway-keys]" >&2; exit 2 ;;
  esac
done
cd "$(dirname "$0")/.."
python3 scripts/check-sbf-tools-version.py
# /tmp is a small tmpfs shared with other sessions; rustc temp files there hit "Disk quota exceeded".
export TMPDIR="${TESORO_TMPDIR:-$HOME/.cache/tesoro-tmp}"
mkdir -p "$TMPDIR"
stamp=$(mktemp)
mkdir -p target/deploy target/idl target/types
if [ "$throwaway" = 1 ]; then
  echo "================ NOT FOR DEPLOY: built with throwaway program keypairs (--throwaway-keys) ================" >&2
else
  keys=(~/.config/tesoro/deploy-keys/*-keypair.json)
  if [ ! -f "${keys[0]}" ]; then
    echo "error: no deploy keys in ~/.config/tesoro/deploy-keys/. A deploy build needs them; for a test-only build pass --throwaway-keys." >&2
    exit 1
  fi
  for key in "${keys[@]}"; do
    [ -f "target/deploy/$(basename "$key")" ] || cp "$key" target/deploy/
  done
fi
tools=$(python3 scripts/check-sbf-toolchain.py tools)
sdk_src="$(dirname "$(readlink -f "$(command -v cargo-build-sbf)")")/platform-tools-sdk/sbf"
sdk=$(mktemp -d "$TMPDIR/tesoro-sbf-sdk.XXXXXX")
cp -r "$sdk_src/c" "$sdk_src/scripts" "$sdk_src/env.sh" "$sdk_src/syscalls.txt" "$sdk/"
mkdir "$sdk/dependencies"
ln -s "$tools" "$sdk/dependencies/platform-tools"
rustc_log=$(mktemp "$TMPDIR/tesoro-sbf-rustc.XXXXXX.log")
build_log=$(mktemp "$TMPDIR/tesoro-sbf-build.XXXXXX.log")
PATH="$tools/rust/bin:$PATH" RUSTC_WRAPPER="$PWD/scripts/sbf-rustc-wrapper.sh" TESORO_SBF_TOOLS="$tools" TESORO_SBF_RUSTC_LOG="$rustc_log" \
  anchor build --no-idl -- --tools-version v1.54 --no-rustup-override --skip-tools-install --sbf-sdk "$sdk" 2>&1 | tee "$build_log"
# LLVM can report an unsafe frame while Cargo still exits zero.
python3 scripts/check-sbf-build-log.py "$build_log"
python3 scripts/check-sbf-toolchain.py rustc-log "$rustc_log"
rm -rf "$sdk"
for dir in programs/*/; do
  grep -q cdylib "$dir/Cargo.toml" || continue
  so="target/deploy/$(basename "$dir").so"
  if [ ! "$so" -nt "$stamp" ]; then echo "error: $so was not rebuilt" >&2; exit 1; fi
done
# LiteSVM enables every feature; the clusters do not. Refuse a syscall no deployed program imports.
python3 scripts/check-sbf-syscalls.py
for dir in programs/*/; do
  grep -q cdylib "$dir/Cargo.toml" || continue
  p=$(basename "$dir")
  anchor idl build -p "$p" -o "target/idl/$p.json" -t "target/types/$p.ts"
done
# The app reads tesoro_core's instructions and types from its own copy of the IDL: keep it in step (keeps the app's `errors`).
node scripts/sync-idl.mjs
# Compile the actual Rust SPACE/INIT_SPACE constants and bind them to these freshly built ELFs.
python3 scripts/predeploy-size-check.py collect --program tesoro_core --program sim_lst --program block_puzzle --program holdem --program trading_duel --program vanguard
