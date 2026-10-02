#!/usr/bin/env bash
# Deploys PositionVaultOApp (PositionVault over LayerZero V2). Key comes from ~/.config/tesoro/evm-deployer.env.
# Usage: script/deploy-oapp.sh <hoodi|hyperevm> <sim|wsteth> [simLstAddress]
#   hoodi  sim    vault for SimLST (SIMULATED yield); pass the deployed SimLST address
#   hoodi  wsteth vault for real Lido wstETH through WstETHRateAdapter
#   hyperevm sim  vault for a SimLST on HyperEVM testnet (deploy the SimLST first: forge create src/SimLST.sol:SimLST --constructor-args <owner> "Simulated Staked HYPE" simHYPE)
# Afterwards: setPeer(40168, <tesoro_bridge Store PDA as bytes32>) on the vault, and register the vault on Solana
# with `bridge/scripts/lz.ts wire`.
set -euo pipefail
source ~/.config/tesoro/evm-deployer.env
SOLANA_EID=40168
case "$1" in
  hoodi) RPC=${HOODI_RPC_URL:-https://ethereum-hoodi-rpc.publicnode.com}; EP=0x3acaaf60502791d199a5a5f0b173d78229ebfe32; EID=40449;;
  hyperevm) RPC=https://rpc.hyperliquid-testnet.xyz/evm; EP=0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1; EID=40362;;
  *) echo "unknown chain"; exit 1;;
esac
case "$2" in
  sim) LST=${3:?SimLST address}; RATE=$LST;;
  wsteth) LST=0x7E99eE3C66636DE415D2d7C880938F2f40f94De4; RATE=0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37;;
  *) echo "unknown asset"; exit 1;;
esac
cd "$(dirname "$0")/.."
forge create src/PositionVaultOApp.sol:PositionVaultOApp --rpc-url "$RPC" --private-key "$EVM_DEPLOYER_PRIVATE_KEY" --broadcast \
  --constructor-args "$LST" "$RATE" "$EP" "$EID" "$SOLANA_EID" "$EVM_DEPLOYER_ADDRESS"
