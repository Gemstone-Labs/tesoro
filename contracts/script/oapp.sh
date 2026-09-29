#!/usr/bin/env bash
# EVM-side driver for PositionVaultOApp. Key comes from ~/.config/tesoro/evm-deployer.env (never printed).
# Usage: script/oapp.sh <hoodi|hyperevm> <vault> <cmd> [args]
#   peer <bridgeStorePda0x>          setPeer(40168, store PDA)
#   quote-open | quote-yield         native fee for the two outbound messages
#   faucet                           SimLST faucet to the deployer (simETH; SIMULATED)
#   approve                          approve the vault to pull the deployer's LST
#   open <lstAmountWei> <months>     openPosition, caller pays the LayerZero fee (quote + 20% headroom, excess refunded)
#   report <positionId>              reportYield, caller pays the fee
#   position <positionId>            vault Position
#   accrued <positionId>             cumulative accrued yield (underlying wei)
#   sign <text>                      EIP-191 personal_sign with the deployer key (for tesoro_bridge link_evm)
set -euo pipefail
source ~/.config/tesoro/evm-deployer.env
case "$1" in
  hoodi) RPC=${HOODI_RPC_URL:-https://ethereum-hoodi-rpc.publicnode.com};;
  hyperevm) RPC=https://rpc.hyperliquid-testnet.xyz/evm;;
  *) echo "unknown chain"; exit 1;;
esac
V=$2; CMD=$3; shift 3
SEND=(cast send --rpc-url "$RPC" --private-key "$EVM_DEPLOYER_PRIVATE_KEY")
fee() { cast call "$V" "$1()(uint256)" --rpc-url "$RPC" | awk '{print $1}'; }
case "$CMD" in
  peer) "${SEND[@]}" "$V" "setPeer(uint32,bytes32)" 40168 "$1";;
  quote-open) fee quotePositionLocked;;
  quote-yield) fee quoteYieldAccrued;;
  faucet) LST=$(cast call "$V" "lst()(address)" --rpc-url "$RPC"); "${SEND[@]}" "$LST" "faucet(address)" "$EVM_DEPLOYER_ADDRESS";;
  approve) LST=$(cast call "$V" "lst()(address)" --rpc-url "$RPC"); "${SEND[@]}" "$LST" "approve(address,uint256)" "$V" "$(cast max-uint)";;
  open) F=$(fee quotePositionLocked); "${SEND[@]}" "$V" "openPosition(uint256,uint8)" "$1" "$2" --value $((F * 12 / 10));;
  report) F=$(fee quoteYieldAccrued); "${SEND[@]}" "$V" "reportYield(uint64)" "$1" --value $((F * 12 / 10));;
  position) cast call "$V" "getPosition(uint64)((address,uint256,uint256,uint256,uint256,uint256,uint256,uint64,uint64,uint64,uint8,bool))" "$1" --rpc-url "$RPC";;
  accrued) cast call "$V" "accruedYield(uint64)(uint256)" "$1" --rpc-url "$RPC";;
  sign) cast wallet sign --private-key "$EVM_DEPLOYER_PRIVATE_KEY" "$1";;
esac
