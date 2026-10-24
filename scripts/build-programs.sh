#!/usr/bin/env bash
# Builds all Solana programs and their IDLs.
# Anchor's default platform tools ship Cargo 1.84, which cannot parse edition-2024 crates in the
# current dependency tree, so programs build with platform tools v1.54 and IDLs build separately.
set -euo pipefail
cd "$(dirname "$0")/.."
# /tmp is a small tmpfs shared with other sessions; rustc temp files there hit "Disk quota exceeded".
export TMPDIR="${TESORO_TMPDIR:-$HOME/.cache/tesoro-tmp}"
mkdir -p "$TMPDIR"
stamp=$(mktemp)
mkdir -p target/deploy target/idl target/types
for key in ~/.config/tesoro/deploy-keys/*-keypair.json; do
  [ -f "target/deploy/$(basename "$key")" ] || cp "$key" target/deploy/
done
anchor build --no-idl -- --tools-version v1.54
for dir in programs/*/; do
  so="target/deploy/$(basename "$dir").so"
  if [ ! "$so" -nt "$stamp" ]; then echo "error: $so was not rebuilt" >&2; exit 1; fi
done
for dir in programs/*/; do
  p=$(basename "$dir")
  anchor idl build -p "$p" -o "target/idl/$p.json" -t "target/types/$p.ts"
done
# The app reads tesoro_core's instructions and types from its own copy of the IDL: keep it in step (keeps the app's `errors`).
node scripts/sync-idl.mjs
# Compile the actual Rust SPACE/INIT_SPACE constants and bind them to these freshly built ELFs.
python3 scripts/predeploy-size-check.py collect --program tesoro_core --program sim_lst --program block_puzzle --program holdem --program trading_duel --program vanguard
