#!/usr/bin/env bash
# Polls LayerZero Scan (testnet) until the message sent in <txHash> is delivered (or fails).
# Usage: scripts/scan.sh <srcTxHash> [maxPolls]   (10 s apart)
# Prints the status, GUID, destination tx and the Scan link.
set -euo pipefail
H=$1
for i in $(seq 1 "${2:-60}"); do
  R=$(curl -s "https://scan-testnet.layerzero-api.com/v1/messages/tx/$H")
  S=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin).get('data');print(d[0]['status']['name'] if d else 'none')" 2>/dev/null || echo none)
  case "$S" in DELIVERED|FAILED|BLOCKED|PAYLOAD_STORED) break;; esac
  sleep 10
done
echo "status $S"
echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'][0];print('guid',d['guid']);print('dest tx',d['destination'].get('tx',{}).get('txHash'))"
echo "https://testnet.layerzeroscan.com/tx/$H"
