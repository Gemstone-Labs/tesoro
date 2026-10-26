// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMessageEndpoint} from "./IRateSource.sol";
import {PositionVaultBase} from "./PositionVaultBase.sol";
import {PrizeModule} from "./PrizeModule.sol";

/// @title PositionVault
/// @notice Holds a Position's Principal in an LST and reports its yield to Solana (design notes in `PositionVaultBase`).
///
/// EIP-170 split: the cash-in batch and prize payout code lives in `PrizeModule`, deployed by this constructor and
/// called by `delegatecall` (it runs on this contract's storage; both inherit `PositionVaultBase`, so the layout is
/// shared by construction). The module address is immutable and the module can only be reached from `_delegate`.
contract PositionVault is PositionVaultBase {
    /// @notice Account allowed to set the Yield Fee, fund the Treasury and withdraw from it (the deployer; the owner
    ///         in the OApp).
    address public immutable admin = msg.sender;
    /// @notice Cash-in batch and prize code this vault delegatecalls (same immutables as the vault).
    PrizeModule public immutable prizeModule;

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_, address yieldMinter_)
        PositionVaultBase(lst_, rateSource_, endpoint_, sourceChain_, yieldMinter_)
    {
        prizeModule = new PrizeModule(lst_, rateSource_, endpoint_, sourceChain_, yieldMinter_);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Moves LST shares from the admin into the Treasury.
    function fundTreasury(uint256 shares) external {
        _checkAdmin();
        if (shares == 0) revert ZeroAmount();
        if (!lst.transferFrom(msg.sender, address(this), shares)) revert TransferFailed();
        uint256 underlying = _value(shares, rateSource.underlyingPerShare());
        if (_real()) treasuryShares += shares;
        else treasuryCredited += underlying;
        emit TreasuryFunded(msg.sender, shares, underlying);
    }

    /// @notice Sends `amount` (underlying) of the Treasury to `to`. Any part of it, any time.
    function withdrawTreasury(uint256 amount, address to) external {
        _checkAdmin();
        if (amount == 0) revert ZeroAmount();
        uint256 available = treasuryBalance();
        if (amount > available) revert InsufficientTreasury(amount, available);
        uint256 shares = (amount * RATE_SCALE) / rateSource.underlyingPerShare();
        if (_real()) treasuryShares -= shares;
        else treasuryWithdrawn += amount;
        _payShares(to, shares);
        emit TreasuryWithdrawn(to, amount, shares);
    }

    function setEscrowKeeper(address keeper) external {
        _checkAdmin();
        escrowKeeper = keeper;
        emit EscrowKeeperSet(keeper);
    }

    /// @notice Moves the Pool's part of the fees into the prize escrow (called by the keeper at Season
    ///         end). `shares == 0` moves all of it. Real vaults move shares between two claims that both sit inside T,
    ///         so the vault stays solvent by construction; SimLST vaults mint the shares. The cumulative `escrowed*`
    ///         figures rise, and the next Yield Report or batch result carries them to Solana.
    function fundPrizeEscrow(uint256 shares) external {
        if (!_isAdmin(msg.sender) && msg.sender != escrowKeeper) revert NotAdminOrKeeper();
        uint256 rate = rateSource.underlyingPerShare();
        uint256 moved;
        uint256 units;
        if (_real()) {
            moved = shares == 0 ? poolOwedShares : shares;
            if (moved > poolOwedShares) revert EscrowTooSmall(moved, poolOwedShares);
            poolOwedShares -= moved;
            units = _value(moved, rate);
        } else {
            uint256 owedUnits = poolOwedUnits();
            units = shares == 0 ? owedUnits : (shares * rate) / RATE_SCALE;
            if (units > owedUnits) revert EscrowTooSmall(units, owedUnits);
            poolFundedUnits += units;
            moved = (units * RATE_SCALE) / rate;
            _mintToEscrow(moved);
        }
        if (moved == 0) revert ZeroAmount();
        _addEscrow(moved, units, false);
    }

    function _isAdmin(address who) internal view virtual returns (bool) {
        return who == admin;
    }

    function _checkAdmin() internal view virtual {
        if (!_isAdmin(msg.sender)) revert NotAdmin();
    }

    // ---------------------------------------------------------------- views

    /// @notice What the vault Treasury can still pay now, in underlying units (the figure a Yield Report carries).
    function treasuryBalance() public view returns (uint256) {
        if (_real()) return _value(spendableTreasuryShares(), rateSource.underlyingPerShare());
        uint256 inflow = realisedFees + treasuryCredited;
        uint256 outflow = treasuryWithdrawn + instantPaid + _poolEntitledUnits();
        return inflow > outflow ? inflow - outflow : 0;
    }

    /// @notice SimLST vaults: the Pool's part of the fees taken so far, in underlying, not yet moved into the escrow.
    function poolOwedUnits() public view returns (uint256) {
        if (_real()) return 0;
        uint256 entitled = _poolEntitledUnits();
        return entitled > poolFundedUnits ? entitled - poolFundedUnits : 0;
    }

    function _poolEntitledUnits() internal view returns (uint256) {
        return _real() ? 0 : poolAccruedUnits;
    }

    /// @notice Real-LST vaults: Treasury shares nobody else has a claim on.
    function spendableTreasuryShares() public view returns (uint256) {
        uint256 claimed = owedShares + poolOwedShares + escrowShares + reservedShares;
        return treasuryShares > claimed ? treasuryShares - claimed : 0;
    }

    function getPosition(uint64 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Cumulative accrued (gross) yield, including what was paid, right now.
    function accruedYield(uint64 id) public view returns (uint256) {
        return _accrued(_positions[id]);
    }

    function payableYield(uint64 id) public view returns (uint256) {
        Position storage p = _positions[id];
        uint256 accrued = _accrued(p);
        return accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
    }

    /// @notice What a PayYield may take now: payable yield minus what pending cash-in batches hold back.
    function unreservedYield(uint64 id) external view returns (uint256) {
        return _unreservedYield(id, _positions[id]);
    }

    // ---------------------------------------------------------------- outbound

    function openPosition(uint256 lstAmount, uint8 horizonMonths) external payable returns (uint64 id) {
        return _openFor(msg.sender, lstAmount, horizonMonths);
    }

    /// @notice Opens a Position owned by `owner` with LST pulled from the caller. Used by the stake-and-open zaps
    ///         (`StakeZap`): the Player's coin is staked and locked in one transaction. The caller pays the
    ///         LayerZero fee and, as `msg.sender` of the send, receives the refund of the excess.
    function openPositionFor(address owner, uint256 lstAmount, uint8 horizonMonths)
        external
        payable
        returns (uint64 id)
    {
        if (owner == address(0)) revert ZeroAmount();
        return _openFor(owner, lstAmount, horizonMonths);
    }

    function _openFor(address owner, uint256 lstAmount, uint8 horizonMonths) internal returns (uint64 id) {
        if (lstAmount == 0) revert ZeroAmount();
        if (horizonMonths < 1 || horizonMonths > 12) revert BadHorizon();

        uint256 rate = rateSource.underlyingPerShare();
        id = ++nextPositionId;
        Position storage p = _positions[id];
        p.owner = owner;
        p.principalShares = lstAmount;
        p.principalUnderlying = (lstAmount * rate) / RATE_SCALE;
        // The bridge hands tesoro_core amounts in 1e-9 units (CORE_UNIT wei, rounded down) held as u64. A Position
        // below one unit would open as zero and never unlock; one above 2^64 units could never open on Solana.
        if (p.principalUnderlying < CORE_UNIT) revert PrincipalBelowUnit();
        if (p.principalUnderlying / CORE_UNIT > type(uint64).max) revert PrincipalTooLarge();
        p.openRate = rate;
        p.openTime = uint64(block.timestamp);
        p.horizonMonths = horizonMonths;
        _open(p);
        uint64 seq = ++p.outSeq;

        if (!lst.transferFrom(msg.sender, address(this), lstAmount)) revert TransferFailed();

        emit PositionLocked(id, owner, lstAmount, horizonMonths, seq);
        _send(
            abi.encode(
                MSG_POSITION_LOCKED,
                sourceChain,
                id,
                seq,
                bytes32(uint256(uint160(owner))),
                bytes32(uint256(uint160(address(lst)))),
                lstAmount,
                p.principalUnderlying,
                rate,
                horizonMonths
            )
        );
    }

    /// @notice Permissionless: reports the Position's cumulative Accrued Yield, the Treasury balance and the cumulative
    ///         Instant payouts, all computed at this block. Payable: a LayerZero subclass charges the caller the message fee.
    function reportYield(uint64 id) external payable {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        // Solana refuses a lower cumulative, so after a rate fall the report carries the high-water mark and the
        // Treasury balance and Instant payouts still go out fresh. The shortfall is the holders' (founder rule D2).
        uint256 accrued = _accrued(p);
        uint256 reported = reportedAccrued[id];
        if (accrued < reported) accrued = reported;
        else reportedAccrued[id] = accrued;
        uint256 treasury = treasuryBalance();
        uint64 seq = ++p.outSeq;
        uint256 rate = rateSource.underlyingPerShare();
        emit YieldAccrued(id, accrued, rate, seq, treasury, instantPaid);
        _send(
            abi.encode(
                MSG_YIELD_ACCRUED,
                sourceChain,
                id,
                seq,
                accrued,
                rate,
                block.timestamp,
                treasury,
                instantPaid,
                escrowedShares,
                escrowedUnits
            )
        );
    }

    // ---------------------------------------------------------------- inbound

    /// @notice Only the messaging endpoint may deliver. A LayerZero subclass calls `_receive` directly instead.
    function receiveMessage(bytes calldata payload) external {
        if (msg.sender != messageEndpoint) revert NotEndpoint();
        _receive(payload);
    }

    function _receive(bytes memory payload) internal virtual {
        (uint8 msgType, uint32 chain, uint64 id, uint64 seq) = abi.decode(payload, (uint8, uint32, uint64, uint64));
        if (msgType == MSG_CASH_IN_BATCH || msgType == MSG_PAY_PRIZE) {
            if (chain != sourceChain) return _ignore(id, msgType, seq, "wrong chain");
            return _delegate(abi.encodeCall(PrizeModule.receivePayload, (payload)));
        }
        if (msgType != MSG_UNLOCK && msgType != MSG_PAY_YIELD && msgType != MSG_PAY_INSTANT) revert UnknownMessage();

        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        if (chain != sourceChain) return _ignore(id, msgType, seq, "wrong chain");
        // Each seq is processed once; a later seq arriving first must not cancel an earlier one.
        if (_handled[id][seq]) return _ignore(id, msgType, seq, "duplicate seq");
        _handled[id][seq] = true;
        if (seq > p.inSeq) p.inSeq = seq; // highest seq seen, informational

        if (msgType == MSG_UNLOCK) {
            _onUnlock(id, p, seq);
        } else {
            if (msgType == MSG_PAY_YIELD) {
                (,,,, bytes32 to, uint256 amount, uint256 fee, uint256 pool) =
                    abi.decode(payload, (uint8, uint32, uint64, uint64, bytes32, uint256, uint256, uint256));
                _onPayYield(id, p, seq, address(uint160(uint256(to))), amount, fee, pool);
            } else {
                (,,,, bytes32 to, uint256 amount) =
                    abi.decode(payload, (uint8, uint32, uint64, uint64, bytes32, uint256));
                _onPayInstant(id, seq, address(uint160(uint256(to))), amount);
            }
        }
    }

    /// @dev Runs a `PrizeModule` entry point on this contract's storage and sends the acknowledgement it returns.
    ///      A revert inside the module reverts the delivery with the same reason.
    function _delegate(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(prizeModule).delegatecall(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        bytes memory ack = abi.decode(ret, (bytes));
        if (ack.length != 0) _sendAck(ack);
    }

    /// @dev Freezes the Position's accrued yield at this block, drops it from the open sums and releases
    ///      Principal (worth principalUnderlying at the current rate) to the owner. Unpaid yield stays claimable
    ///      by redeemers.
    function _onUnlock(uint64 id, Position storage p, uint64 seq) internal {
        if (p.unlocked) return _ignore(id, MSG_UNLOCK, seq, "already unlocked");
        p.frozenAccrued = _gross(p, _clock());
        _close(p);
        p.unlocked = true;

        uint256 rate = rateSource.underlyingPerShare();
        uint256 release = (p.principalUnderlying * RATE_SCALE + rate - 1) / rate;
        if (release > p.principalShares) release = p.principalShares;
        if (yieldMinter == address(0)) {
            if (release > p.heldShares) release = p.heldShares;
            _moveLeftoverToTreasury(id, p, rate, release);
        }
        if (!lst.transfer(p.owner, release)) revert TransferFailed();
        emit PositionUnlocked(id, p.owner, release, seq);
    }

    /// @dev Real LSTs: everything the Position still holds beyond the shares released to its owner joins the Treasury
    ///      (the unpaid yield, owed to its holders). The unpaid yield becomes `owedShares` at the Unlock rate, rounded
    ///      down and never above what moved, so the Treasury always holds at least what it owes.
    function _moveLeftoverToTreasury(uint64 id, Position storage p, uint256 rate, uint256 release) internal {
        uint256 rest = p.heldShares - release;
        openHeldShares -= p.heldShares;
        p.heldShares = 0;
        treasuryShares += rest;
        uint256 unpaid = p.frozenAccrued > p.paidUnderlying ? p.frozenAccrued - p.paidUnderlying : 0;
        uint256 owed = (unpaid * RATE_SCALE) / rate;
        if (owed > rest) owed = rest;
        unlockRate[id] = rate;
        owedSharesOf[id] = owed;
        owedShares += owed;
    }

    /// @dev `amount` leaves the Position's yield; `fee` of it (at most the Yield Fee cap) stays with the Treasury and
    ///      the holder gets the rest.
    ///      `pool` is the part of the Treasury's share owed to the Leaderboard Pool, never above what the Treasury
    ///      gains here, so the Treasury always holds what the Pool is owed. A refill (`to == vault`) keeps all of it.
    function _onPayYield(
        uint64 id,
        Position storage p,
        uint64 seq,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 pool
    ) internal {
        if (fee * BPS > amount * MAX_YIELD_FEE_BPS || pool > amount) revert BadFeeSplit(amount, fee, pool);
        uint256 available = _unreservedYield(id, p);
        if (amount > available) revert ExceedsAccruedYield(amount, available);

        (uint256 shares, bool settled) = _debitYield(id, p, amount);
        uint256 rate = settled ? unlockRate[id] : rateSource.underlyingPerShare();
        if (to == address(this)) {
            // Tesoro redeemed the Gemas it bought with Instant Redeems: the yield goes back to the Treasury. No
            // tokens move; the yield was never minted (SimLST) or is already among the held shares (real). With the
            // holders' claim gone, shares of an unlocked Position become spendable.
            if (!settled) {
                if (_real()) treasuryShares += shares;
                else treasuryCredited += amount;
            }
            _owePool(pool, amount, shares, rate);
            emit TreasuryRefilled(id, amount, seq);
            return;
        }
        // Shares rounded down (less than one share-wei of value): paying never lowers the reported cumulative,
        // which tesoro_core refuses (CumulativeDecreased). The fee shares are what is left of the debit.
        uint256 holderShares = ((amount - fee) * RATE_SCALE) / rate;
        uint256 feeShares = shares - holderShares;
        if (_real()) {
            if (settled) treasuryShares -= holderShares;
            else treasuryShares += feeShares;
        } else {
            realisedFees += fee;
        }
        _owePool(pool, fee, feeShares, rate);
        _payShares(to, holderShares);
        emit YieldPaid(id, to, amount - fee, holderShares, seq);
    }

    /// @dev Records `poolUnits` as owed to the Leaderboard Pool, capped at `capUnits` / `capShares`, the part the
    ///      Treasury gained in this cash-out. Shares are floored.
    function _owePool(uint256 poolUnits, uint256 capUnits, uint256 capShares, uint256 rate) internal {
        if (_real()) {
            uint256 poolShares = (poolUnits * RATE_SCALE) / rate;
            poolOwedShares += poolShares < capShares ? poolShares : capShares;
        } else {
            poolAccruedUnits += poolUnits < capUnits ? poolUnits : capUnits;
        }
    }

    /// @dev Yield a PayYield may take now: what the Position can still pay minus what pending batches reserved.
    function _unreservedYield(uint64 id, Position storage p) internal view returns (uint256) {
        uint256 accrued = _accrued(p);
        uint256 available = accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
        uint256 held = reservedUnits[id];
        return available > held ? available - held : 0;
    }

    /// @dev Pays `amount` underlying out of the Treasury, independent of the Position's own shares and lock state.
    ///      Solana has already taken the holder's Gemas, so a payout the Treasury cannot cover now must not be
    ///      dropped: it reverts, which also leaves the seq unhandled, and the same message is delivered again (the
    ///      Yield Fee keeps growing the Treasury; the owner can fund it) and pays once.
    function _onPayInstant(uint64 id, uint64 seq, address to, uint256 amount) internal {
        uint256 available = treasuryBalance();
        uint256 shares = (amount * RATE_SCALE) / rateSource.underlyingPerShare();
        if (amount > available) revert InsufficientTreasury(amount, available);
        if (shares > _spendable()) revert InsufficientShares(shares, _spendable());
        if (_real()) treasuryShares -= shares;
        instantPaid += amount;
        _payShares(to, shares);
        emit InstantPaid(id, to, amount, shares, seq);
    }

    // ---------------------------------------------------------------- cash-in batches and prizes

    /// @notice The persistent receipt of a batch: what was asked, what was paid so far, what is held back.
    function batchOf(uint64 batchId)
        external
        view
        returns (bool exists, uint8 kind, bytes32 recipient, BatchEntry[] memory entries)
    {
        Batch storage b = _batches[batchId];
        return (b.exists, b.kind, b.recipient, b.entries);
    }

    /// @notice Regenerates the acknowledgement of a batch (the vault pays nothing; the caller pays the message fee in
    ///         a LayerZero subclass).
    function resendBatchResult(uint64 batchId) external payable {
        if (!_batches[batchId].exists) revert UnknownMessage();
        _send(_batchResult(batchId));
    }

    function resendPayPrizeResult(uint64 payoutId) external payable {
        if (payouts[payoutId].status == 0) revert UnknownMessage();
        _send(_payoutResult(payoutId));
    }

    // ---------------------------------------------------------------- transport seam

    /// @dev Acknowledgements are sent from inside a delivery, where there is no caller to charge. A LayerZero subclass
    ///      pays from the vault's own balance and never reverts the delivery when it cannot; `resend*Result` answers again.
    function _sendAck(bytes memory payload) internal virtual {
        _send(payload);
    }

    /// @dev Override to send through LayerZero. Default: the configured endpoint.
    function _send(bytes memory payload) internal virtual {
        IMessageEndpoint(messageEndpoint).send(payload);
    }
}
