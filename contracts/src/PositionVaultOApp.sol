// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OApp, Origin, MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {MessagingParams} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PositionVault} from "./PositionVault.sol";
import {PrizeModule} from "./PrizeModule.sol";

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
///   2 YieldAccrued   (EVM to Solana): header | uint128 cumulativeAccruedUnderlying | uint128 treasuryBalance | uint128 instantPaid | uint64 reportTime | uint128 escrowedShares | uint128 escrowedUnits (133 bytes)
///                     escrowedShares / escrowedUnits = vault-wide CUMULATIVE inflow into the prize escrow (vault shares, and the
///                     underlying value each share had when it arrived). They only grow; Solana issues prize Gemas up to them.
///                     treasuryBalance = what the vault Treasury can still pay now. It rises with fees and refills and FALLS
///                     with Instant Redeems and withdrawals (it used to be the only-growing treasuryIn).
///                     instantPaid = the vault's cumulative Instant Redeem payouts at the same block; Solana subtracts the payouts it
///                     recorded that this figure does not cover yet (they are still waiting to be paid).
///                     reportTime = block.timestamp of the report; Solana takes a Treasury snapshot only if it is not older than the
///                     one it holds, so an old report cannot be replayed over a newer one.
///   3 Unlock         (Solana to EVM): header | uint128 0
///   4 PayYield       (Solana to EVM): header | bytes32 to | uint128 amountUnderlying
///   5 PayInstant     (Solana to EVM): header | bytes32 to | uint128 amountUnderlying (paid from the Treasury; reverts, and is delivered again, while the Treasury holds less)
///   Route messages (6-9) use key = vault address (20 bytes) | 12 zero bytes and the id field carries the batch / payout id:
///   6 CashInBatch    (Solana to EVM): header | uint8 kind (0 Platform, 1 Studio, 2 Leaderboard) | bytes32 recipient | uint8 n (1..8) | n x (uint64 positionId | uint128 units)
///   7 PayPrize       (Solana to EVM): header | bytes32 asset | bytes32 prizeSource | bytes32 recipient | uint128 shares (157 bytes)
///   8 BatchResult    (EVM to Solana): header | uint8 n | n x uint128 paidUnits (CUMULATIVE per entry) | uint128 escrowedShares | uint128 escrowedUnits
///   9 PayPrizeResult (EVM to Solana): header | uint8 status (1 paid, 2 rejected) | uint128 shares (62 bytes)
///   Results are sent from the vault's own native balance (fund it by sending native to the vault); when it cannot pay
///   the fee the delivery still succeeds and anyone can call `resendBatchResult` / `resendPayPrizeResult` with the fee.
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
    error BadRecipient();
    error AmountTooLarge();
    error NativeSendFailed();

    event AckSent(uint8 msgType, uint64 id);
    event AckNotSent(uint8 msgType, uint64 id, string reason);

    constructor(
        address lst_,
        address rateSource_,
        address lzEndpoint_,
        uint32 chainEid_,
        uint32 solanaEid_,
        address delegate_,
        address yieldMinter_
    )
        PositionVault(lst_, rateSource_, lzEndpoint_, chainEid_, yieldMinter_)
        OApp(lzEndpoint_, delegate_)
        Ownable(delegate_)
    {
        require(endpoint.eid() == chainEid_, "eid mismatch");
        solanaEid = solanaEid_;
    }

    /// @notice The vault pays the LayerZero fee of the results it sends from a delivery out of its own balance.
    receive() external payable {}

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeSendFailed();
    }

    function setSolanaReceiveCu(uint128 cu) external onlyOwner {
        solanaReceiveCu = cu;
    }

    function _checkAdmin() internal view override {
        _checkOwner();
    }

    function _isAdmin(address who) internal view override returns (bool) {
        return who == owner();
    }

    // ------------------------------------------------------------------ quotes

    /// @notice Native fee to send `openPosition`'s message.
    function quotePositionLocked() external view returns (uint256) {
        return _quote(solanaEid, _packLocked(1, 1, 1, bytes32(0), bytes32(0), 1, 1), _options(), false).nativeFee;
    }

    /// @notice Native fee to send `reportYield`'s message.
    function quoteYieldAccrued() external view returns (uint256) {
        return _quote(
            solanaEid, abi.encodePacked(_packYield(1, 1, 1, 1, 1, 1, 1), uint128(1), uint128(1)), _options(), false
        )
        .nativeFee;
    }

    /// @notice Native fee to send the result of a batch with `entries` entries.
    function quoteBatchResult(uint8 entries) external view returns (uint256) {
        return _quote(solanaEid, new bytes(45 + 1 + 16 * uint256(entries) + 32), _options(), false).nativeFee;
    }

    /// @notice Native fee to send a PayPrize result.
    function quotePayPrizeResult() external view returns (uint256) {
        return _quote(solanaEid, new bytes(62), _options(), false).nativeFee;
    }

    // ------------------------------------------------------------------ outbound

    /// @dev Re-encodes the vault's abi payload (all static words) into the packed wire format and sends it;
    ///      msg.value is the fee, the excess is refunded to msg.sender.
    function _send(bytes memory payload) internal override {
        _lzSend(solanaEid, _encodeOutbound(payload), _options(), MessagingFee(msg.value, 0), payable(msg.sender));
    }

    /// @dev Result sent from inside a delivery: the fee comes from the vault's balance, refunds return to it, and a
    ///      shortfall or a failing endpoint never reverts the delivery (the receipt is already stored).
    function _sendAck(bytes memory payload) internal override {
        uint8 msgType = uint8(uint256(_word(payload, 0)));
        uint64 id = uint64(uint256(_word(payload, 2)));
        bytes memory message = _encodeOutbound(payload);
        bytes memory options = _options();
        uint256 fee = _quote(solanaEid, message, options, false).nativeFee;
        if (address(this).balance < fee) {
            emit AckNotSent(msgType, id, "vault balance below the message fee");
            return;
        }
        try endpoint.send{value: fee}(
            MessagingParams(solanaEid, _getPeerOrRevert(solanaEid), message, options, false), address(this)
        ) {
            emit AckSent(msgType, id);
        } catch {
            emit AckNotSent(msgType, id, "endpoint refused the send");
        }
    }

    /// @dev Re-encodes the vault's abi payload (static words, or dynamic for results) into the packed wire format.
    function _encodeOutbound(bytes memory payload) internal view returns (bytes memory message) {
        uint8 msgType = uint8(uint256(_word(payload, 0)));
        uint32 chain = uint32(uint256(_word(payload, 1)));
        if (msgType == MSG_BATCH_RESULT || msgType == MSG_PAY_PRIZE_RESULT) {
            return prizeModule.encodeResult(payload, address(this));
        }
        uint256 key = _positionKey(uint64(uint256(_word(payload, 2))));
        uint64 seq = uint64(uint256(_word(payload, 3)));
        if (msgType == MSG_POSITION_LOCKED) {
            // words: owner, lst, lstAmount, principalUnderlying, rate, horizon
            return _packLocked(
                chain,
                key,
                seq,
                _word(payload, 4),
                _word(payload, 5),
                _u128(uint256(_word(payload, 7))),
                uint8(uint256(_word(payload, 9)))
            );
        }
        if (msgType == MSG_YIELD_ACCRUED) {
            // words: accrued, rate, timestamp, treasuryBalance, instantPaid, escrowedShares, escrowedUnits
            return abi.encodePacked(
                _packYield(
                    chain,
                    key,
                    seq,
                    _u128(uint256(_word(payload, 4))),
                    _u128(uint256(_word(payload, 7))),
                    _u128(uint256(_word(payload, 8))),
                    uint64(uint256(_word(payload, 6)))
                ),
                _u128(uint256(_word(payload, 9))),
                _u128(uint256(_word(payload, 10)))
            );
        }
        revert InvalidMessageType();
    }

    // ------------------------------------------------------------------ inbound

    /// @dev `OAppReceiver.lzReceive` has already checked msg.sender == endpoint and origin.sender == the peer set
    ///      for origin.srcEid, so only the registered `tesoro_bridge` reaches this function.
    function _lzReceive(Origin calldata, bytes32, bytes calldata message, address, bytes calldata) internal override {
        if (message.length < 45) revert InvalidMessageLength();
        uint8 msgType = uint8(message[0]);
        uint32 chain = uint32(bytes4(message[1:5]));
        bytes32 positionKey = bytes32(message[5:37]);
        uint64 seq = uint64(bytes8(message[37:45]));
        if (address(bytes20(positionKey)) != address(this)) revert WrongVault();

        if (msgType == MSG_CASH_IN_BATCH) {
            if (uint96(uint256(positionKey)) != 0) revert WrongVault();
            _delegate(abi.encodeCall(PrizeModule.receiveWire, (chain, seq, message)));
            return;
        }
        if (msgType == MSG_PAY_PRIZE) {
            if (uint96(uint256(positionKey)) != 0) revert WrongVault();
            _delegate(abi.encodeCall(PrizeModule.receiveWire, (chain, seq, message)));
            return;
        }

        // A Position key is vault << 96 | id << 32; the low 32 bits are always zero.
        if (uint32(uint256(positionKey)) != 0) revert WrongVault();
        uint64 id = uint64(uint256(positionKey) >> 32);
        if (msgType == MSG_UNLOCK) {
            if (message.length != 61) revert InvalidMessageLength();
            _receive(abi.encode(msgType, chain, id, seq));
        } else if (msgType == MSG_PAY_YIELD) {
            // header 45 | to 32 | amount u128 | fee u128 | pool u128
            if (message.length != 125) revert InvalidMessageLength();
            _receivePayYield(chain, id, seq, message);
        } else if (msgType == MSG_PAY_INSTANT) {
            if (message.length != 93) revert InvalidMessageLength();
            bytes32 to = _recipient(message[45:77]);
            uint256 amount = uint128(bytes16(message[77:93]));
            _receive(abi.encode(msgType, chain, id, seq, to, amount));
        } else {
            revert InvalidMessageType();
        }
    }

    function _receivePayYield(uint32 chain, uint64 id, uint64 seq, bytes calldata message) internal {
        _receive(
            abi.encode(
                MSG_PAY_YIELD,
                chain,
                id,
                seq,
                _recipient(message[45:77]),
                uint256(uint128(bytes16(message[77:93]))),
                uint256(uint128(bytes16(message[93:109]))),
                uint256(uint128(bytes16(message[109:125])))
            )
        );
    }

    // ------------------------------------------------------------------ helpers

    /// @dev A padded EVM address. Reverts (the LayerZero message stays retryable) rather than truncate a word that
    ///      holds more than 20 bytes and pay a different wallet.
    function _recipient(bytes calldata word) internal pure returns (bytes32 w) {
        w = bytes32(word);
        (, bool ok) = _wallet(w);
        if (!ok) revert BadRecipient();
    }

    function _word(bytes memory data, uint256 i) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(data, add(32, mul(i, 32))))
        }
    }

    function _positionKey(uint64 id) internal view returns (uint256) {
        return (uint256(uint160(address(this))) << 96) | (uint256(id) << 32);
    }

    function _vaultKey() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(this))) << 96);
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

    function _packYield(
        uint32 chain,
        uint256 key,
        uint64 seq,
        uint128 cumulative,
        uint128 treasury,
        uint128 paid,
        uint64 time
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(MSG_YIELD_ACCRUED, chain, bytes32(key), seq, cumulative, treasury, paid, time);
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
