#!/bin/sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/.riptide/sim"
OUT_DIR="${RIPTIDE_OUT_DIR:-$SIM_DIR/artifacts/sol-price-shock}"
FLOWS="${RIPTIDE_FLOWS:-1}"
SEED="${RIPTIDE_SEED:-1337}"

riptide sim run "$SIM_DIR" --flows "$FLOWS" --seed "$SEED" --out "$OUT_DIR"

python3 - "$OUT_DIR/guided-sim-run.json" <<'PY'
import json, sys

data = json.load(open(sys.argv[1]))
totals = data.get("totals", {})
failed_iters = [
    i.get("iteration")
    for i in data.get("iterations", [])
    if i.get("status") != "passed"
    or i.get("error") is not None
    or bool(i.get("panic"))
    or i.get("first_failure") is not None
]
if (
    data.get("status") != "passed"
    or totals.get("errors", 0) > 0
    or totals.get("panics", 0) > 0
    or totals.get("unexpected_errors", 0) > 0
    or failed_iters
):
    sys.stderr.write(
        f"Riptide run failed: status={data.get('status')}, totals={totals}, failed_iterations={failed_iters}\n"
    )
    sys.exit(1)
PY
