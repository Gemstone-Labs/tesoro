#!/usr/bin/env bash
# EVM-side driver for the spike OApp. Usage:
#   script/spike/evm.sh <hoodi|hyperevm> <oapp> peer <solanaStorePda0x>
#   script/spike/evm.sh <hoodi|hyperevm> <oapp> quote
#   script/spike/evm.sh <hoodi|hyperevm> <oapp> send <type 1|2> <positionId0x> <amount>
#   script/spike/evm.sh <hoodi|hyperevm> <oapp> state <positionId0x>
#   script/spike/evm.sh <hoodi|hyperevm> <oapp> config       # resolved send/receive ULN + executor config vs Solana (40168)
set -euo pipefail
source ~/.config/tesoro/evm-deployer.env
case "$1" in
  hoodi) RPC=${HOODI_RPC_URL:-https://ethereum-hoodi-rpc.publicnode.com}; EP=0x3acaaf60502791d199a5a5f0b173d78229ebfe32; SENDLIB=0x45841dd1ca50265da7614fc43a361e526c0e6160; RECVLIB=0xd682ecf100f6f4284138aa925348633b0611ae21;;
  hyperevm) RPC=https://rpc.hyperliquid-testnet.xyz/evm; EP=0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1; SENDLIB=0x43e505ba192aac7babdc1a796c87844171011684; RECVLIB=0x012f6eae2a0bf5916f48b5f37c62bcfb7c1ffda1;;
esac
OAPP=$2; CMD=$3; shift 3
SOLANA_EID=40168
# Options: type-3, executor lzReceive option: gas (u128) + value (u128, lamports for Position PDA rent).
# 0x0003 | 01 (worker=executor) | 0021 (len 33) | 01 (LZ_RECEIVE) | gas u128 | value u128
# The default Executors on Hoodi and HyperEVM cap native drop to Solana at 0, so VALUE must stay 0
# (a value option reverts NativeAmountExceedsCap): Position PDAs are pre-created on Solana instead.
GAS=${SOLANA_RECEIVE_CU:-200000}; VALUE=${SOLANA_RECEIVE_VALUE:-0}
if [ "$VALUE" = 0 ]; then OPTIONS=$(printf "0x0003010011 01%032x" "$GAS" | tr -d ' '); else OPTIONS=$(printf "0x000301002101%032x%032x" "$GAS" "$VALUE"); fi
case "$CMD" in
  peer) cast send "$OAPP" "setPeer(uint32,bytes32)" $SOLANA_EID "$1" --rpc-url "$RPC" --private-key "$EVM_DEPLOYER_PRIVATE_KEY";;
  quote) cast call "$OAPP" "quoteSend(bytes)((uint256,uint256))" "$OPTIONS" --rpc-url "$RPC";;
  send)
    FEE=$(cast call "$OAPP" "quoteSend(bytes)((uint256,uint256))" "$OPTIONS" --rpc-url "$RPC" | sed 's/(\([0-9]*\).*/\1/')
    # 20% headroom over the quote
    cast send "$OAPP" "sendPosition(uint8,bytes32,uint128,bytes)" "$1" "$2" "$3" "$OPTIONS" --value $((FEE * 12 / 10)) --rpc-url "$RPC" --private-key "$EVM_DEPLOYER_PRIVATE_KEY";;
  state) cast call "$OAPP" "lastIn(bytes32)(uint64,uint8,uint128)" "$1" --rpc-url "$RPC"; cast call "$OAPP" "lastOutSeq(bytes32)(uint64)" "$1" --rpc-url "$RPC";;
  config)
    cast call "$EP" "getSendLibrary(address,uint32)(address)" "$OAPP" $SOLANA_EID --rpc-url "$RPC"
    cast call "$SENDLIB" "getUlnConfig(address,uint32)((uint64,uint8,uint8,uint8,address[],address[]))" "$OAPP" $SOLANA_EID --rpc-url "$RPC"
    cast call "$EP" "getReceiveLibrary(address,uint32)(address,bool)" "$OAPP" $SOLANA_EID --rpc-url "$RPC"
    cast call "$RECVLIB" "getUlnConfig(address,uint32)((uint64,uint8,uint8,uint8,address[],address[]))" "$OAPP" $SOLANA_EID --rpc-url "$RPC";;
esac
