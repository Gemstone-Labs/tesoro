#!/usr/bin/env bash
# pnpm --filter @tesoro/app bombadil [spec.ts]
set -euo pipefail
app_dir=$(cd "$(dirname "$0")/.." && pwd)
trace_dir=$(realpath "${BOMBADIL_TRACE_DIR:-$app_dir/bombadil}")
mkdir -p "$trace_dir"
spec=$(realpath "${1:-$app_dir/bombadil/tesoro.spec.ts}")
[[ -f "$spec" ]] || { echo "Missing specification: $spec" >&2; exit 1; }
# Keep Turbopack's workspace and pnpm symlink targets in the same tree, outside the app.
root=$(mktemp -d "$app_dir/../.bombadil-XXXXXXXX")
server=
job=
stop_session() {
  local pid=$1
  [[ -n "$pid" ]] || return 0
  # Chrome creates its own process group within the Bombadil session.
  pkill -TERM -s "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    pgrep -s "$pid" >/dev/null || break
    sleep 0.1
  done
  pkill -KILL -s "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  stop_session "$job"
  stop_session "$server"
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -R "$app_dir"/{src,stories,.storybook,package.json,tsconfig.json,next.config.ts} "$root/"
ln -sr "$app_dir/node_modules" "$root/node_modules"
ln -sr "$app_dir/assets" "$root/assets"
ln -sr "$app_dir/public" "$root/public"
cp "$app_dir/bombadil/server.mjs" "$root/"
cd "$root"
mkdir tmp home
# Mount the very same context as AccountProvider's guest branch, without bundling Privy.
cat > src/lib/auth/AccountProvider.tsx <<'GUEST'
"use client";
import type { ReactNode } from "react";
import { AuthContext, UNCONFIGURED } from "./context";
export function AccountProvider({ children }: { children: ReactNode }) {
  return <AuthContext.Provider value={UNCONFIGURED}>{children}</AuthContext.Provider>;
}
GUEST
mv next.config.ts tesoro.config.ts
cat > next.config.ts <<'CONFIG'
import path from "node:path";
import config from "./tesoro.config";
export default { ...config, turbopack: { ...config.turbopack, root: path.resolve("..") }, experimental: { ...config.experimental, cpus: 1 } };
CONFIG
export TMPDIR="$root/tmp"

# Choose a free loopback port. The owned server must signal readiness (also catches a bind race).
port=$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
origin="http://127.0.0.1:$port"
fixture="$origin/fixture"
# Neither the operator's shell credentials nor app/.env.local enter the build or server.
app_env=(env -i "HOME=$root/home" "PATH=$PATH" "TMPDIR=$TMPDIR"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 RAYON_NUM_THREADS=2
  NODE_OPTIONS=--max-old-space-size=2048
  NEXT_PUBLIC_TESORO_CLUSTER=test TESORO_CLUSTER=test "NEXT_PUBLIC_SITE_URL=$origin"
  "NEXT_PUBLIC_SOLANA_RPC=$fixture/solana" "TESORO_BASE_RPC=$fixture/solana" "TESORO_GPA_RPC=$fixture/solana"
  "NEXT_PUBLIC_HOODI_RPC=$fixture/hoodi" "NEXT_PUBLIC_HYPEREVM_RPC=$fixture/hyperevm"
  "NEXT_PUBLIC_MAGICBLOCK_ER_RPC=$fixture/solana" "NEXT_PUBLIC_MAGICBLOCK_TEE_RPC=$fixture/solana"
  "NEXT_PUBLIC_MAGICBLOCK_ER_WS=ws://127.0.0.1:$port/fixture/er" "NEXT_PUBLIC_MAGICBLOCK_TEE_WS=ws://127.0.0.1:$port/fixture/tee"
  "SUPABASE_URL=$fixture" SUPABASE_SERVICE_ROLE_KEY=bombadil-local-fixture)

setsid "${app_env[@]}" node node_modules/next/dist/bin/next build &
job=$!
wait "$job"
stop_session "$job"
job=
setsid "${app_env[@]}" node server.mjs >server.log 2>&1 &
server=$!
for _ in {1..300}; do
  if grep -q 'Tesoro fixture ready' server.log; then break; fi
  kill -0 "$server" 2>/dev/null || { cat server.log >&2; exit 1; }
  sleep 0.2
done
grep -q 'Tesoro fixture ready' server.log || { cat server.log >&2; exit 1; }

routes=(play 'play/practice?game=holdem' vault backing leaderboard docs)

for viewport in desktop mobile; do
  if [[ "$viewport" == desktop ]]; then width=1440; height=900; else width=390; height=844; fi
  trace="$trace_dir/$viewport.bin"
  echo "$viewport (${width}x${height}): $trace"
  # Instrumenting inline scripts rewrites Docs ThemeBoot before React hydrates its HTML.
  setsid bombadil browser test --instrument-javascript files --chrome-variant headless-shell --width "$width" --height "$height" \
    --time-limit 90s --exit-on-violation --output-path "$trace" --output-path-overwrite "$origin/play" "$spec" &
  job=$!
  wait "$job" || { status=$?; cat server.log >&2; exit "$status"; }
  stop_session "$job"
  job=
  if [[ "$spec" == "$app_dir/bombadil/tesoro.spec.ts" ]]; then
    bombadil trace --json "$trace" | node "$app_dir/bombadil/coverage.mjs" "${routes[@]}"
  fi
done
