#!/usr/bin/env bash
# Usage: script/spike/deploy.sh <hoodi|hyperevm>   (needs ~/.config/tesoro/evm-deployer.env)
set -euo pipefail
source ~/.config/tesoro/evm-deployer.env
case "$1" in
  hoodi) RPC=${HOODI_RPC_URL:-https://ethereum-hoodi-rpc.publicnode.com}; EP=0x3acaaf60502791d199a5a5f0b173d78229ebfe32; EXTRA="";;
  hyperevm) RPC=https://rpc.hyperliquid-testnet.xyz/evm; EP=0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1; EXTRA="";;
  *) echo "unknown chain"; exit 1;;
esac
cd "$(dirname "$0")/../.."
forge create src/spike/TesoroSpikeOApp.sol:TesoroSpikeOApp --rpc-url "$RPC" --private-key "$EVM_DEPLOYER_PRIVATE_KEY" --broadcast \
  --constructor-args "$EP" "$EVM_DEPLOYER_ADDRESS" $EXTRA
