// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PositionVaultBase} from "./PositionVaultBase.sol";
import {IERC20Minimal} from "./IRateSource.sol";

/// @title PrizeModule
/// @notice The cash-in batch and prize payout half of `PositionVault`, split out to keep the vault under the EIP-170
///         code-size limit. A vault deploys one in its constructor (same immutables) and reaches it only by
///         `delegatecall` from `PositionVault._delegate`, so it reads and writes the vault's storage; both inherit
///         `PositionVaultBase`, which holds all state. It adds no state of its own.
///
///         Every entry point returns the acknowledgement payload (empty = none) instead of sending it: the vault's
///         transport sends it. Called directly (not through a vault) an entry point reverts.
contract PrizeModule is PositionVaultBase {
    error DirectCall();
    error InvalidMessageLength();
    error AmountTooLarge();

    address private immutable self = address(this);

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_, address yieldMinter_)
        PositionVaultBase(lst_, rateSource_, endpoint_, sourceChain_, yieldMinter_)
    {}

    /// @notice Wire encoding (packed, big-endian) of the two result messages the vault sends to Solana, from the vault's
    ///         abi payload (`_batchResult` / `_payoutResult`). Pure: it touches no storage, `vault` is the calling
    ///         vault (its address is the message key), so anyone may call it.
    function encodeResult(bytes calldata payload, address vault) external pure returns (bytes memory) {
        (uint8 msgType, uint32 chain, uint64 id,) = abi.decode(payload, (uint8, uint32, uint64, uint64));
        bytes32 key = bytes32(uint256(uint160(vault)) << 96);
        if (msgType == MSG_BATCH_RESULT) {
            (,,,, uint128[] memory paid, uint256 escShares, uint256 escUnits) =
                abi.decode(payload, (uint8, uint32, uint64, uint64, uint128[], uint256, uint256));
            if (escShares > type(uint128).max || escUnits > type(uint128).max) revert AmountTooLarge();
            bytes memory body = abi.encodePacked(uint8(paid.length));
            for (uint256 i; i < paid.length; i++) {
                body = abi.encodePacked(body, paid[i]);
            }
            return abi.encodePacked(msgType, chain, key, id, body, uint128(escShares), uint128(escUnits));
        }
        (,,,, uint8 status, uint128 shares) = abi.decode(payload, (uint8, uint32, uint64, uint64, uint8, uint128));
        return abi.encodePacked(msgType, chain, key, id, status, shares);
    }

    /// @notice Entry point for a LayerZero wire message of type 6 or 7 (the vault's OApp has checked the sender, the
    ///         vault key and that the low key bits are zero). Layouts: see `PositionVaultOApp`.
    function receiveWire(uint32 chain, uint64 seq, bytes calldata message) external returns (bytes memory ack) {
        if (address(this) == self) revert DirectCall();
        uint8 msgType = uint8(message[0]);
        uint64 id = seq;
        if (msgType == MSG_PAY_PRIZE) {
            if (message.length != 157) revert InvalidMessageLength();
            if (chain != sourceChain) {
                emit MessageIgnored(id, msgType, 0, "wrong chain");
                return "";
            }
            return _onPayPrize(
                id,
                bytes32(message[45:77]),
                bytes32(message[77:109]),
                bytes32(message[109:141]),
                uint128(bytes16(message[141:157]))
            );
        }
        if (message.length < 80) revert InvalidMessageLength();
        uint8 kind = uint8(message[45]);
        bytes32 recipient = bytes32(message[46:78]);
        uint256 n = uint8(message[78]);
        if (n == 0 || n > MAX_BATCH_ENTRIES || message.length != 79 + 24 * n) revert InvalidMessageLength();
        uint64[] memory ids = new uint64[](n);
        uint128[] memory units = new uint128[](n);
        for (uint256 i; i < n; i++) {
            uint256 at = 79 + 24 * i;
            ids[i] = uint64(bytes8(message[at:at + 8]));
            units[i] = uint128(bytes16(message[at + 8:at + 24]));
        }
        if (chain != sourceChain) {
            emit MessageIgnored(id, msgType, 0, "wrong chain");
            return "";
        }
        return _onCashInBatch(id, kind, recipient, ids, units);
    }

    /// @notice Entry point for an abi payload of a batch (6) or prize (7) message; the vault has checked the chain.
    function receivePayload(bytes calldata payload) external returns (bytes memory ack) {
        if (address(this) == self) revert DirectCall();
        (uint8 msgType,, uint64 id,) = abi.decode(payload, (uint8, uint32, uint64, uint64));
        if (msgType == MSG_CASH_IN_BATCH) {
            (,,,, uint8 kind, bytes32 recipient, uint64[] memory ids, uint128[] memory units) =
                abi.decode(payload, (uint8, uint32, uint64, uint64, uint8, bytes32, uint64[], uint128[]));
            return _onCashInBatch(id, kind, recipient, ids, units);
        }
        (,,,, bytes32 asset, bytes32 prizeSource, bytes32 to, uint256 shares) =
            abi.decode(payload, (uint8, uint32, uint64, uint64, bytes32, bytes32, bytes32, uint256));
        return _onPayPrize(id, asset, prizeSource, to, shares);
    }

    /// @dev Executes a batch from Solana: pays each named Position's yield (the same rules as PayYield, capped at
    ///      what that Position can pay now), to `recipient` (kinds 0 and 1) or into the prize escrow (kind 2), then
    ///      acknowledges with the CUMULATIVE paid amounts. It never reverts for a shortfall: what could not be paid stays
    ///      reserved on its Position and the same batch, delivered again, pays it as yield and shares allow. A batch is
    ///      keyed by its id; a delivery whose content differs from the stored one is ignored.
    function _onCashInBatch(uint64 batchId, uint8 kind, bytes32 recipient, uint64[] memory ids, uint128[] memory units)
        internal
        returns (bytes memory)
    {
        if (kind > KIND_LEADERBOARD || ids.length == 0 || ids.length > MAX_BATCH_ENTRIES || ids.length != units.length)
        {
            emit BatchIgnored(batchId, "malformed");
            return "";
        }
        Batch storage b = _batches[batchId];
        bytes32 digest = keccak256(abi.encode(kind, recipient, ids, units));
        if (!b.exists) {
            b.exists = true;
            b.kind = kind;
            b.recipient = recipient;
            b.digest = digest;
            for (uint256 i; i < ids.length; i++) {
                b.entries.push(BatchEntry(ids[i], units[i], 0, 0));
            }
        } else if (b.digest != digest) {
            emit BatchIgnored(batchId, "content differs from the stored batch");
            return "";
        }

        (address to, bool toOk) = _wallet(recipient);
        bool wallet = kind != KIND_LEADERBOARD;
        uint256 paidNow;
        bool complete = true;
        for (uint256 i; i < b.entries.length; i++) {
            BatchEntry storage e = b.entries[i];
            if (!wallet || toOk) paidNow += _payEntry(e, to, wallet);
            if (e.paid < e.requested) complete = false;
        }
        emit BatchExecuted(batchId, kind, paidNow, complete);
        return _batchResult(batchId);
    }

    /// @dev Pays one batch entry. Returns the underlying paid now.
    function _payEntry(BatchEntry storage e, address to, bool wallet) internal returns (uint256 paid) {
        Position storage p = _positions[e.positionId];
        if (p.owner == address(0)) return 0;
        uint64 pid = e.positionId;
        uint256 others = reservedUnits[pid] - e.reserved;
        uint256 accrued = _accrued(p);
        uint256 payable_ = accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
        paid = _entryPayable(pid, e.requested - e.paid, payable_, others);
        if (paid > 0) {
            e.paid += uint128(paid);
            _payOut(pid, p, paid, to, wallet);
        }
        _holdBack(e, pid, others);
    }

    /// @dev What an entry may pay now: its unpaid part, within the Position's yield not held for other batches and,
    ///      for an unlocked real-LST Position, within the shares still owed to its holders.
    function _entryPayable(uint64 pid, uint256 unpaid, uint256 payable_, uint256 others)
        internal
        view
        returns (uint256 paid)
    {
        uint256 avail = payable_ > others ? payable_ - others : 0;
        paid = unpaid < avail ? unpaid : avail;
        uint256 cap = _owedCap(pid);
        if (paid > cap) paid = cap;
    }

    /// @dev Underlying an unlocked real-LST Position's holders can still draw (their claim, in shares, at the Unlock
    ///      rate); unbounded otherwise. A payment of `a` debits `floor(a * RATE_SCALE / rate)` shares, so the most
    ///      the owed shares cover is the largest `a` that still debits no more than them, not `owed * rate`
    ///      rounded down (that left the last wei of every claim unpayable and a batch for the whole claim short).
    function _owedCap(uint64 pid) internal view returns (uint256) {
        if (!_real() || !_positions[pid].unlocked) return type(uint256).max;
        uint256 owed = owedSharesOf[pid];
        if (owed == 0) return 0;
        return ((owed + 1) * unlockRate[pid] - 1) / RATE_SCALE;
    }

    function _payOut(uint64 pid, Position storage p, uint256 paid, address to, bool wallet) internal {
        (uint256 shares, bool settled) = _debitYield(pid, p, paid);
        if (wallet) {
            if (settled) treasuryShares -= shares;
            _payShares(to, shares);
            emit YieldPaid(pid, to, paid, shares, 0);
            return;
        }
        // Prize escrow: the shares stay in the vault. A real vault counts them inside T as a claim only PayPrize
        // spends (shares of an unlocked Position already are in T); a SimLST vault mints them now.
        if (_real()) {
            if (!settled) treasuryShares += shares;
        } else {
            _mintToEscrow(shares);
        }
        _addEscrow(shares, paid, true);
    }

    /// @dev Holds back the unpaid rest of an entry, so yield that lands later goes to the pending batch before any
    ///      other PayYield. Bounded by what the Position can still ever pay (an unlocked Position's remaining claim).
    function _holdBack(BatchEntry storage e, uint64 pid, uint256 others) internal {
        uint256 left = e.requested - e.paid;
        uint256 cap = _reserveCap(pid);
        uint256 reserve = left < cap ? left : cap;
        reservedUnits[pid] = others + reserve;
        e.reserved = uint128(reserve);
    }

    function _reserveCap(uint64 pid) internal view returns (uint256) {
        Position storage p = _positions[pid];
        if (!p.unlocked) return type(uint256).max;
        if (_real()) return _owedCap(pid);
        return p.frozenAccrued > p.paidUnderlying ? p.frozenAccrued - p.paidUnderlying : 0;
    }

    /// @dev Pays a prize from the escrow, once per payout id, to `to`. It debits only the escrow, so it works with an
    ///      empty Treasury. A payout that can never pay is recorded as rejected and never pays later; the answer
    ///      (1 paid / 2 rejected) is regenerated on every delivery.
    function _onPayPrize(uint64 payoutId, bytes32 asset, bytes32 prizeSource, bytes32 recipient, uint256 shares)
        internal
        returns (bytes memory)
    {
        Payout storage r = payouts[payoutId];
        bytes32 digest = keccak256(abi.encode(asset, prizeSource, recipient, shares));
        if (r.status != 0) {
            if (r.digest != digest) {
                emit PrizeRejected(payoutId, "content differs from the stored payout");
                return "";
            }
            return _payoutResult(payoutId);
        }
        r.digest = digest;
        r.shares = uint128(shares);
        (address to, bool toOk) = _wallet(recipient);
        string memory why;
        if (shares == 0 || shares > type(uint128).max) why = "zero or oversize shares";
        else if (asset != bytes32(uint256(uint160(address(lst))))) why = "wrong asset";
        else if (!toOk || to == address(this)) why = "bad recipient";
        else if (shares > escrowShares) why = "escrow short";
        if (bytes(why).length == 0) {
            escrowShares -= shares;
            if (_real()) treasuryShares -= shares;
            if (_tryTransfer(to, shares)) {
                r.status = PRIZE_PAID;
                emit PrizePaid(payoutId, to, shares);
            } else {
                escrowShares += shares;
                if (_real()) treasuryShares += shares;
                why = "transfer failed";
            }
        }
        if (r.status == 0) {
            r.status = PRIZE_REJECTED;
            emit PrizeRejected(payoutId, why);
        }
        return _payoutResult(payoutId);
    }

    function _tryTransfer(address to, uint256 shares) internal returns (bool) {
        (bool ok, bytes memory ret) =
            address(lst).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, shares));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
