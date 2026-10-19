// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IERC20Minimal, IMessageEndpoint, IYieldMinter} from "./IRateSource.sol";

/// @title PositionVault
/// @notice Holds a Position's Principal in an LST and reports its yield to Solana, where Gemas and Debt live.
///
/// Accrued Yield is computed when needed, never recorded by a crank (docs/adr/0010):
///   gross(now) = principalUnderlying * (growth since open - 1)
///   fee        = gross * feeBps / BPS          (feeBps fixed per Position at open, floored)
///   accrued    = gross - fee                   (cumulative: includes what was already paid out)
/// Only `growth` depends on the asset:
///  - SimLST (`yieldMinter != 0`): 1 + apyBps/BPS * (now - openTime) * speedup / YEAR, with apyBps and speedup read
///    from the SimLST when the Position opens. The SimLST rate stays flat; shares are minted only when a payout
///    needs them (`_payShares`).
///  - Real rate source (`yieldMinter == 0`, e.g. wstETH): computed from what the Position actually holds, so yield
///    is never counted on shares already paid out: gross = heldShares * rate + paidUnderlying - principalUnderlying.
///    Nothing is minted. A payout lowers heldShares and raises paidUnderlying by the same value, so gross is unchanged.
///
/// Every Position's gross yield is linear in one clock X (SimLST: block.timestamp; real: the rate):
/// gross_i = (a_i * X + d_i - b_i) / DEN, with (a, b, d) = (apy*speedup*Pu, a*openTime, 0) for a SimLST and
/// (heldShares, Pu*1e18, paidUnderlying*1e18) for a real LST. The vault keeps the fee-weighted sums over open Positions
/// (sumFeeA, sumFeeB, sumFeeD), updated on open, payout and Unlock, so the Treasury's share of the fees is a running
/// claim computed from totals with no loop and no crank.
///
/// A rate fall (kHYPE can be slashed) never makes Accrued Yield negative: growth below the open rate counts as zero.
/// A Yield Report that would carry less than an earlier one is refused (`YieldBelowReported`), because Solana would
/// reject the lower cumulative after the Player paid for the message.
///
/// Treasury (underlying units) = fees of open Positions + fees of closed Positions (realised at Unlock)
///   + funding + refills - withdrawals - Instant Redeem payouts.
/// `reportYield(id)` is permissionless and sends `(accrued, treasuryBalance)`: what the vault Treasury can still pay
/// now. An Instant Redeem payout the Treasury cannot cover reverts and waits: the same message pays once the Treasury holds enough.
///
/// Messaging seam: outbound goes through `_send(bytes)`; inbound enters through `receiveMessage(bytes)`, which is
/// authorised to the endpoint and forwards to `_receive(bytes)`. A LayerZero OApp subclass overrides `_send` and
/// calls `_receive` from `_lzReceive` (after its own peer check); the payload format does not change.
contract PositionVault {
    uint256 public constant RATE_SCALE = 1e18;
    uint8 public constant MSG_POSITION_LOCKED = 1;
    uint8 public constant MSG_YIELD_ACCRUED = 2;
    uint8 public constant MSG_UNLOCK = 3;
    uint8 public constant MSG_PAY_YIELD = 4;
    uint8 public constant MSG_PAY_INSTANT = 5;
    uint16 public constant MAX_YIELD_FEE_BPS = 5000;

    struct Position {
        address owner;
        uint256 principalShares;
        uint256 principalUnderlying;
        uint256 openRate;
        uint256 paidUnderlying;
        uint256 frozenAccrued;
        /// @dev gross yield = (a * X + d - b) / DEN, X = timestamp (SimLST) or rate (real). See `_open`.
        uint256 a;
        uint256 b;
        uint256 d;
        /// @dev Real LSTs only: shares the Position still holds in the vault (backing Principal and unpaid yield).
        uint256 heldShares;
        uint256 apyBps;
        uint256 speedup;
        uint64 openTime;
        uint64 outSeq;
        uint64 inSeq;
        uint16 feeBps;
        uint8 horizonMonths;
        bool unlocked;
    }

    IERC20Minimal public immutable lst;
    IRateSource public immutable rateSource;
    address public immutable messageEndpoint;
    /// @notice Tesoro chain id carried in every payload; the Solana side keys Positions by (sourceChain, positionId).
    uint32 public immutable sourceChain;
    /// @notice SimLST that mints simulated yield into this vault; address(0) for rate-based LSTs.
    address public immutable yieldMinter;
    /// @notice Account allowed to set the Yield Fee, fund the Treasury and withdraw from it (the deployer; the owner
    ///         in the OApp).
    address public immutable admin = msg.sender;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @notice Yield Fee for Positions opened from now on, in basis points. A Position keeps the fee it opened with.
    uint16 public yieldFeeBps = 2000;

    // Sums over open Positions (see the header).
    uint256 public sumFeeA; // sum of a_i * feeBps_i
    uint256 public sumFeeB; // sum of b_i * feeBps_i
    uint256 public sumFeeD; // sum of d_i * feeBps_i
    /// @notice Sum of principalUnderlying over open Positions: the shares that back it are never spent on payouts.
    uint256 public openPrincipalUnderlying;
    /// @notice Fees of Positions already unlocked (fixed at Unlock).
    uint256 public realisedFees;
    /// @notice Cumulative underlying added by `fundTreasury` and by refills (PayYield to the vault).
    uint256 public treasuryCredited;
    /// @notice Cumulative underlying taken by `withdrawTreasury`.
    uint256 public treasuryWithdrawn;
    /// @notice Cumulative underlying paid out by Instant Redeem.
    uint256 public instantPaid;

    uint64 public nextPositionId;
    mapping(uint64 => Position) internal _positions;
    /// @dev Inbound seqs already processed, per position. Delivery order is not guaranteed by the transport
    ///      (LayerZero executes verified messages in any order and retries reverted ones), so idempotency is
    ///      per seq, not "strictly increasing".
    mapping(uint64 => mapping(uint64 => bool)) internal _handled;
    /// @notice Highest Accrued Yield a Yield Report has carried for a Position.
    mapping(uint64 => uint256) public reportedAccrued;

    event PositionLocked(
        uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq
    );
    event YieldAccrued(
        uint64 indexed positionId, uint256 cumulativeAccrued, uint256 rate, uint64 seq, uint256 treasuryBalance
    );
    event PositionUnlocked(uint64 indexed positionId, address indexed owner, uint256 sharesReleased, uint64 seq);
    event YieldPaid(
        uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq
    );
    event TreasuryFunded(address indexed from, uint256 shares, uint256 underlying);
    event TreasuryRefilled(uint64 indexed positionId, uint256 amountUnderlying, uint64 seq);
    event TreasuryWithdrawn(address indexed to, uint256 amountUnderlying, uint256 shares);
    event InstantPaid(
        uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq
    );
    event YieldFeeSet(uint16 bps);
    event YieldMinted(uint256 shares);
    event MessageIgnored(uint64 indexed positionId, uint8 msgType, uint64 seq, string reason);

    error NotEndpoint();
    error BadHorizon();
    error ZeroAmount();
    error UnknownPosition();
    error UnknownMessage();
    error TransferFailed();
    error ExceedsAccruedYield(uint256 requested, uint256 available);
    error InsufficientShares(uint256 needed, uint256 spendable);
    error PrincipalTooLarge();
    error NotAdmin();
    error FeeTooHigh();
    error InsufficientTreasury(uint256 needed, uint256 available);
    /// @dev Solana refuses a cumulative lower than one it applied (CumulativeDecreased); a rate fall can push the
    ///      Accrued Yield under what an earlier report said, so that report waits for the rate to recover.
    error YieldBelowReported(uint256 accrued, uint256 reported);

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_, address yieldMinter_) {
        lst = IERC20Minimal(lst_);
        rateSource = IRateSource(rateSource_);
        messageEndpoint = endpoint_;
        sourceChain = sourceChain_;
        yieldMinter = yieldMinter_;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Sets the Yield Fee for Positions opened afterwards; open Positions keep theirs.
    function setYieldFeeBps(uint16 bps) external {
        _checkAdmin();
        if (bps > MAX_YIELD_FEE_BPS) revert FeeTooHigh();
        yieldFeeBps = bps;
        emit YieldFeeSet(bps);
    }

    /// @notice Moves LST shares from the admin into the Treasury.
    function fundTreasury(uint256 shares) external {
        _checkAdmin();
        if (shares == 0) revert ZeroAmount();
        if (!lst.transferFrom(msg.sender, address(this), shares)) revert TransferFailed();
        uint256 underlying = _value(shares, rateSource.underlyingPerShare());
        treasuryCredited += underlying;
        emit TreasuryFunded(msg.sender, shares, underlying);
    }

    /// @notice Sends `amount` (underlying) of the Treasury to `to`. Any part of it, any time.
    function withdrawTreasury(uint256 amount, address to) external {
        _checkAdmin();
        if (amount == 0) revert ZeroAmount();
        uint256 available = treasuryBalance();
        if (amount > available) revert InsufficientTreasury(amount, available);
        treasuryWithdrawn += amount;
        uint256 shares = (amount * RATE_SCALE) / rateSource.underlyingPerShare();
        _payShares(to, shares);
        emit TreasuryWithdrawn(to, amount, shares);
    }

    function _checkAdmin() internal view virtual {
        if (msg.sender != admin) revert NotAdmin();
    }

    // ---------------------------------------------------------------- views

    /// @notice What the vault Treasury can still pay now, in underlying units (the figure a Yield Report carries).
    function treasuryBalance() public view returns (uint256) {
        uint256 inflow = _openFees(_clock()) + realisedFees + treasuryCredited;
        uint256 outflow = treasuryWithdrawn + instantPaid;
        return inflow > outflow ? inflow - outflow : 0;
    }

    function getPosition(uint64 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Cumulative accrued yield (net of the Yield Fee, including what was paid) right now.
    function accruedYield(uint64 id) public view returns (uint256) {
        return _accrued(_positions[id]);
    }

    function payableYield(uint64 id) public view returns (uint256) {
        Position storage p = _positions[id];
        uint256 accrued = _accrued(p);
        return accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
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
        // tesoro_core keeps Principal as u64; a larger Position could never open on Solana and never unlock.
        if (p.principalUnderlying > type(uint64).max) revert PrincipalTooLarge();
        p.openRate = rate;
        p.openTime = uint64(block.timestamp);
        p.horizonMonths = horizonMonths;
        p.feeBps = yieldFeeBps;
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

    /// @notice Permissionless: reports the Position's cumulative Accrued Yield and the Treasury balance, both
    ///         computed at this block. Payable: a LayerZero subclass charges the caller the message fee.
    function reportYield(uint64 id) external payable {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        uint256 accrued = _accrued(p);
        if (accrued < reportedAccrued[id]) revert YieldBelowReported(accrued, reportedAccrued[id]);
        reportedAccrued[id] = accrued;
        uint256 treasury = treasuryBalance();
        uint64 seq = ++p.outSeq;
        uint256 rate = rateSource.underlyingPerShare();
        emit YieldAccrued(id, accrued, rate, seq, treasury);
        _send(abi.encode(MSG_YIELD_ACCRUED, sourceChain, id, seq, accrued, rate, block.timestamp, treasury));
    }

    // ---------------------------------------------------------------- inbound

    /// @notice Only the messaging endpoint may deliver. A LayerZero subclass calls `_receive` directly instead.
    function receiveMessage(bytes calldata payload) external {
        if (msg.sender != messageEndpoint) revert NotEndpoint();
        _receive(payload);
    }

    function _receive(bytes memory payload) internal virtual {
        (uint8 msgType, uint32 chain, uint64 id, uint64 seq) = abi.decode(payload, (uint8, uint32, uint64, uint64));
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
            (,,,, bytes32 to, uint256 amount) = abi.decode(payload, (uint8, uint32, uint64, uint64, bytes32, uint256));
            if (msgType == MSG_PAY_YIELD) _onPayYield(id, p, seq, address(uint160(uint256(to))), amount);
            else _onPayInstant(id, seq, address(uint160(uint256(to))), amount);
        }
    }

    /// @dev Freezes the Position's accrued yield and fee at this block, drops it from the open sums and releases
    ///      Principal (worth principalUnderlying at the current rate) to the owner. Unpaid yield stays claimable
    ///      by redeemers.
    function _onUnlock(uint64 id, Position storage p, uint64 seq) internal {
        if (p.unlocked) return _ignore(id, MSG_UNLOCK, seq, "already unlocked");
        uint256 gross = _gross(p, _clock());
        uint256 fee = (gross * p.feeBps) / BPS;
        p.frozenAccrued = gross - fee;
        realisedFees += fee;
        _close(p);
        p.unlocked = true;

        uint256 rate = rateSource.underlyingPerShare();
        uint256 release = (p.principalUnderlying * RATE_SCALE + rate - 1) / rate;
        if (release > p.principalShares) release = p.principalShares;
        if (yieldMinter == address(0)) {
            if (release > p.heldShares) release = p.heldShares;
            p.heldShares -= release;
        }
        if (!lst.transfer(p.owner, release)) revert TransferFailed();
        emit PositionUnlocked(id, p.owner, release, seq);
    }

    function _onPayYield(uint64 id, Position storage p, uint64 seq, address to, uint256 amount) internal {
        uint256 accrued = _accrued(p);
        uint256 available = accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
        if (amount > available) revert ExceedsAccruedYield(amount, available);

        p.paidUnderlying += amount;
        uint256 shares = (amount * RATE_SCALE) / rateSource.underlyingPerShare();
        _recordPayout(p, shares, amount);
        if (to == address(this)) {
            // Tesoro redeemed the Gemas it bought with Instant Redeems: the yield goes back to the Treasury. No
            // tokens move; the yield was never minted (SimLST) or is already among the held shares (real).
            treasuryCredited += amount;
            emit TreasuryRefilled(id, amount, seq);
            return;
        }
        // Shares rounded down (less than one share-wei of value): paying never lowers the reported cumulative,
        // which tesoro_core refuses (CumulativeDecreased).
        _payShares(to, shares);
        emit YieldPaid(id, to, amount, shares, seq);
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
        instantPaid += amount;
        _payShares(to, shares);
        emit InstantPaid(id, to, amount, shares, seq);
    }

    function _ignore(uint64 id, uint8 msgType, uint64 seq, string memory reason) internal {
        emit MessageIgnored(id, msgType, seq, reason);
    }

    // ---------------------------------------------------------------- math

    function _value(uint256 shares, uint256 rate) internal pure returns (uint256) {
        return (shares * rate) / RATE_SCALE;
    }

    /// @dev The clock the gross yield is linear in: time for a SimLST, the rate for a real LST.
    function _clock() internal view returns (uint256) {
        return yieldMinter != address(0) ? block.timestamp : rateSource.underlyingPerShare();
    }

    function _den() internal view returns (uint256) {
        return yieldMinter != address(0) ? BPS * YEAR : RATE_SCALE;
    }

    /// @dev Stores the Position's linear coefficients and adds it to the open sums.
    function _open(Position storage p) internal {
        uint256 pu = p.principalUnderlying;
        uint256 a;
        uint256 b;
        if (yieldMinter != address(0)) {
            IYieldMinter m = IYieldMinter(yieldMinter);
            p.apyBps = m.apyBps();
            p.speedup = m.speedup();
            a = pu * p.apyBps * p.speedup;
            b = a * block.timestamp;
        } else {
            a = p.principalShares;
            b = pu * RATE_SCALE;
            p.heldShares = a;
        }
        p.a = a;
        p.b = b;
        sumFeeA += a * p.feeBps;
        sumFeeB += b * p.feeBps;
        openPrincipalUnderlying += pu;
    }

    function _close(Position storage p) internal {
        sumFeeA -= p.a * p.feeBps;
        sumFeeB -= p.b * p.feeBps;
        sumFeeD -= p.d * p.feeBps;
        openPrincipalUnderlying -= p.principalUnderlying;
    }

    /// @dev The Position's gross yield (before the Yield Fee) at clock `x`; zero if the rate fell below its open rate.
    function _gross(Position storage p, uint256 x) internal view returns (uint256) {
        uint256 hi = p.a * x + p.d;
        return hi > p.b ? (hi - p.b) / _den() : 0;
    }

    /// @dev Yield Fees accrued so far by all open Positions.
    function _openFees(uint256 x) internal view returns (uint256) {
        uint256 hi = sumFeeA * x + sumFeeD;
        return hi > sumFeeB ? (hi - sumFeeB) / (_den() * BPS) : 0;
    }

    /// @dev Cumulative Accrued Yield: gross minus the Yield Fee, frozen at Unlock.
    function _accrued(Position storage p) internal view returns (uint256) {
        if (p.unlocked) return p.frozenAccrued;
        uint256 gross = _gross(p, _clock());
        return gross - (gross * p.feeBps) / BPS;
    }

    /// @dev Real LSTs: shares that leave the Position stop earning, so move their value from heldShares to the paid
    ///      total. Gross yield (heldShares * rate + paid - Principal) is unchanged by the move. After Unlock the
    ///      Position is frozen and out of the sums.
    function _recordPayout(Position storage p, uint256 shares, uint256 amount) internal {
        if (yieldMinter != address(0) || p.unlocked) return;
        uint256 f = p.feeBps;
        p.a -= shares;
        p.heldShares -= shares;
        p.d += amount * RATE_SCALE;
        sumFeeA -= shares * f;
        sumFeeD += amount * RATE_SCALE * f;
    }

    /// @dev Shares a real-LST vault may pay out: its balance minus the shares that back open Principal.
    function _spendable() internal view returns (uint256) {
        if (yieldMinter != address(0)) return type(uint256).max; // short shares are minted
        uint256 bal = lst.balanceOf(address(this));
        uint256 reserve = _reserve();
        return bal > reserve ? bal - reserve : 0;
    }

    function _reserve() internal view returns (uint256) {
        uint256 rate = rateSource.underlyingPerShare();
        return (openPrincipalUnderlying * RATE_SCALE + rate - 1) / rate;
    }

    /// @dev Sends `shares` to `to`. A SimLST vault pays from shares it holds beyond open Principal first (funding,
    ///      leftovers) and mints the rest, so yield is only minted at the moment it is paid. A real-LST vault
    ///      pays from its balance and reverts (retryable) when that would eat open Principal.
    function _payShares(address to, uint256 shares) internal {
        if (shares == 0) return;
        if (yieldMinter != address(0)) {
            uint256 bal = lst.balanceOf(address(this));
            uint256 reserve = _reserve();
            uint256 free = bal > reserve ? bal - reserve : 0;
            if (shares > free) {
                IYieldMinter(yieldMinter).mint(address(this), shares - free);
                emit YieldMinted(shares - free);
            }
        } else {
            uint256 spendable = _spendable();
            if (shares > spendable) revert InsufficientShares(shares, spendable);
        }
        if (!lst.transfer(to, shares)) revert TransferFailed();
    }

    // ---------------------------------------------------------------- transport seam

    /// @dev Override to send through LayerZero. Default: the configured endpoint.
    function _send(bytes memory payload) internal virtual {
        IMessageEndpoint(messageEndpoint).send(payload);
    }
}
