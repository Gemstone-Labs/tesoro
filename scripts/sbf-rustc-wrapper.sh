#!/usr/bin/env bash
# RUSTC_WRAPPER for scripts/build-programs.sh: records the real path of every rustc the build runs and refuses one
# outside the pinned platform tools. Cargo cannot tell platform tools v1.52 and v1.54 apart (same `rustc -vV`), and the
# shared `solana` rustup toolchain is re-pointed by every `cargo build-sbf` on the machine, so without this a build
# can silently mix compilers (2026-11-23: a broken railcar.so, Railcar ticket 37).
set -euo pipefail
tools=${TESORO_SBF_TOOLS:?set by build-programs.sh}
log=${TESORO_SBF_RUSTC_LOG:?set by build-programs.sh}
rustc=$(command -v -- "$1") || { echo "sbf-rustc-wrapper: rustc '$1' is not on PATH" >&2; exit 1; }
real=$(readlink -f -- "$rustc")
echo "$real" >> "$log"
case "$real" in
  "$tools"/*) shift; exec "$real" "$@" ;;
  *) echo "error: rustc resolved to $real, outside the pinned platform tools $tools; run pnpm build:programs, which pins them by path" >&2; exit 1 ;;
esac
