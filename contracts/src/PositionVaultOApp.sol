// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OApp, Origin, MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title PositionVaultOApp
/// @notice PositionVault carried over LayerZero V2 to the `tesoro_bridge` program on Solana.
///
/// Who pays: whoever calls `openPosition` / `reportYield` pays the LayerZero fee in the chain's native token.
/// Read the price with `quotePositionLocked()` / `quoteYieldAccrued()` and send it (plus headroom, the excess is
/// refunded to the caller) as `msg.value`.
///
/// Wire format (identical to bridge/programs/tesoro_bridge/src/msg_codec.rs; abi.encodePacked, big-endian):
///   header  : uint8 msgType | uint32 sourceChain | bytes32 positionId | uint64 seq                    (45 bytes)
///   1 PositionLocked (EVM to Solana): header | bytes32 owner | bytes32 lst | uint128 principalUnderlying | uint8 horizon
///   2 YieldAccrued   (EVM to Solana): header | uint128 cumulativeAccruedUnderlying
///   3 Unlock         (Solana to EVM): header | uint128 0
///   4 PayYield       (Solana to EVM): header | bytes32 to | uint128 amountUnderlying
/// `sourceChain` is this chain's LayerZero eid. `positionId` = vault address (20 bytes) | vault position id
/// (uint64) | 4 zero bytes, so several vaults on one chain never collide on Solana and a vault can only
/// speak for its own Positions.
contract PositionVaultOApp is PositionVault, OApp {
    /// LayerZero eid of Solana (devnet on the testnet endpoints).
    uint32 public immutable solanaEid;
    /// Compute units the executor grants `lz_receive` on Solana (about 60k used).
    uint128 public solanaReceiveCu = 200_000;

    error InvalidMessageLength();
    error InvalidMessageType();
    error WrongVault();
    error AmountTooLarge();

    constructor(
        address lst_,
        address rateSource_,
        address lzEndpoint_,
        uint32 chainEid_,
        uint32 solanaEid_,
        address delegate_,
        address yieldMinter_
    ) PositionVault(lst_, rateSource_, lzEndpoint_, chainEid_, yieldMinter_) OApp(lzEndpoint_, delegate_) Ownable(delegate_) {
        require(endpoint.eid() == chainEid_, "eid mismatch");
        solanaEid = solanaEid_;
    }

    function setSolanaReceiveCu(uint128 cu) external onlyOwner {
        solanaReceiveCu = cu;
    }

    // ------------------------------------------------------------------ quotes

    /// @notice Native fee to send `openPosition`'s message.
    function quotePositionLocked() external view returns (uint256) {
        return _quote(solanaEid, _packLocked(1, 1, 1, bytes32(0), bytes32(0), 1, 1), _options(), false).nativeFee;
    }

    /// @notice Native fee to send `reportYield`'s message.
    function quoteYieldAccrued() external view returns (uint256) {
        return _quote(solanaEid, _packYield(1, 1, 1, 1), _options(), false).nativeFee;
    }

    // ------------------------------------------------------------------ outbound

    /// @dev Re-encodes the vault's abi payload (all static words) into the packed wire format and sends it;
    ///      msg.value is the fee, the excess is refunded to msg.sender.
    function _send(bytes memory payload) internal override {
        uint8 msgType = uint8(uint256(_word(payload, 0)));
        uint32 chain = uint32(uint256(_word(payload, 1)));
        uint256 key = _positionKey(uint64(uint256(_word(payload, 2))));
        uint64 seq = uint64(uint256(_word(payload, 3)));
        bytes memory message;
        if (msgType == MSG_POSITION_LOCKED) {
            // words: owner, lst, lstAmount, principalUnderlying, rate, horizon
            message = _packLocked(
                chain,
                key,
                seq,
                _word(payload, 4),
                _word(payload, 5),
                _u128(uint256(_word(payload, 7))),
                uint8(uint256(_word(payload, 9)))
            );
        } else if (msgType == MSG_YIELD_ACCRUED) {
            // words: accrued, rate, timestamp
            message = _packYield(chain, key, seq, _u128(uint256(_word(payload, 4))));
        } else {
            revert InvalidMessageType();
        }
        _lzSend(solanaEid, message, _options(), MessagingFee(msg.value, 0), payable(msg.sender));
    }

    // ------------------------------------------------------------------ inbound

    /// @dev `OAppReceiver.lzReceive` has already checked msg.sender == endpoint and origin.sender == the peer set
    ///      for origin.srcEid, so only the registered `tesoro_bridge` reaches this function.
    function _lzReceive(Origin calldata, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        if (message.length < 45) revert InvalidMessageLength();
        uint8 msgType = uint8(message[0]);
        uint32 chain = uint32(bytes4(message[1:5]));
        bytes32 positionKey = bytes32(message[5:37]);
        uint64 seq = uint64(bytes8(message[37:45]));
        if (address(bytes20(positionKey)) != address(this)) revert WrongVault();
        uint64 id = uint64(uint256(positionKey) >> 32);

        if (msgType == MSG_UNLOCK) {
            if (message.length != 61) revert InvalidMessageLength();
            _receive(abi.encode(msgType, chain, id, seq));
        } else if (msgType == MSG_PAY_YIELD) {
            if (message.length != 93) revert InvalidMessageLength();
            bytes32 to = bytes32(message[45:77]);
            uint256 amount = uint128(bytes16(message[77:93]));
            _receive(abi.encode(msgType, chain, id, seq, to, amount));
        } else {
            revert InvalidMessageType();
        }
    }

    // ------------------------------------------------------------------ helpers

    function _word(bytes memory data, uint256 i) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(data, add(32, mul(i, 32))))
        }
    }

    function _positionKey(uint64 id) internal view returns (uint256) {
        return (uint256(uint160(address(this))) << 96) | (uint256(id) << 32);
    }

    function _packLocked(
        uint32 chain,
        uint256 key,
        uint64 seq,
        bytes32 owner,
        bytes32 asset,
        uint128 principal,
        uint8 horizon
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(MSG_POSITION_LOCKED, chain, bytes32(key), seq, owner, asset, principal, horizon);
    }

    function _packYield(uint32 chain, uint256 key, uint64 seq, uint128 cumulative)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(MSG_YIELD_ACCRUED, chain, bytes32(key), seq, cumulative);
    }

    function _options() internal view returns (bytes memory) {
        // Type-3 options: executor (worker 1) LZ_RECEIVE (type 1) with gas = compute units, no native drop
        // (the default executors cap the drop to Solana at 0).
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), solanaReceiveCu);
    }

    function _u128(uint256 v) internal pure returns (uint128) {
        if (v > type(uint128).max) revert AmountTooLarge();
        return uint128(v);
    }
}
