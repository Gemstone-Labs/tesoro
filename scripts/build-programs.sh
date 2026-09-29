#!/usr/bin/env bash
# Builds all Solana programs and their IDLs.
# Anchor's default platform tools ship Cargo 1.84, which cannot parse edition-2024 crates in the
# current dependency tree, so programs build with platform tools v1.54 and IDLs build separately.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p target/deploy target/idl target/types
for key in ~/.config/tesoro/deploy-keys/*-keypair.json; do
  [ -f "target/deploy/$(basename "$key")" ] || cp "$key" target/deploy/
done
anchor build --no-idl -- --tools-version v1.54
for dir in programs/*/; do
  p=$(basename "$dir")
  anchor idl build -p "$p" -o "target/idl/$p.json" -t "target/types/$p.ts"
done
