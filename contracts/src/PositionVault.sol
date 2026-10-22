// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IERC20Minimal, IMessageEndpoint, IYieldMinter} from "./IRateSource.sol";

/// @title PositionVault
/// @notice Holds a Position's Principal in an LST and reports its yield to Solana, where Gemas and Debt live.
///
/// Accrued Yield is computed when needed, never recorded by a crank (docs/adr/0010):
///   accrued = principalUnderlying * (growth since open - 1)   (cumulative: includes what was already paid out)
/// Gemas are 100% of a Position's yield: the vault reports and pays the GROSS yield. The 20% Yield Fee is charged
/// when yield leaves ("cash-out"), and Solana computes the split for every cash-out and names it in the PayYield
/// message: `amount` leaves the Position, `fee` of it stays with the Treasury (the holder gets `amount - fee`), and
/// `pool` is the part of the Treasury's share owed to the Leaderboard Pool. Fee-class cash-in batches and prizes
/// are exempt and carry no split. Nothing is taken at Unlock.
/// Only `growth` depends on the asset:
///  - SimLST (`yieldMinter != 0`): 1 + apyBps/BPS * (now - openTime) * speedup / YEAR, with apyBps and speedup read
///    from the SimLST when the Position opens. The SimLST rate stays flat; shares are minted only when a payout
///    needs them (`_payShares`).
///  - Real rate source (`yieldMinter == 0`, e.g. wstETH): computed from what the Position actually holds, so yield
///    is never counted on shares already paid out: accrued = heldShares * rate + paidUnderlying - principalUnderlying.
///    Nothing is minted. A payout lowers heldShares and raises paidUnderlying by the same value, so accrued is unchanged.
///
/// Every Position's yield is linear in one clock X (SimLST: block.timestamp; real: the rate):
/// accrued_i = (a_i * X + d_i - b_i) / DEN, with (a, b, d) = (apy*speedup*Pu, a*openTime, 0) for a SimLST and
/// (heldShares, Pu*1e18, paidUnderlying*1e18) for a real LST.
///
/// A rate fall (kHYPE can be slashed) never makes Accrued Yield negative: growth below the open rate counts as zero.
/// A Yield Report that would carry less than an earlier one is refused (`YieldBelowReported`), because Solana would
/// reject the lower cumulative after the Player paid for the message.
///
/// Treasury, real-LST vaults (`yieldMinter == 0`): held in LST SHARES (`treasuryShares`, T), valued at the live rate.
///   spendableShares = max(0, T - owedShares - poolOwedShares - reservedShares)
///   treasuryBalance = spendableShares * rate / 1e18
/// It spends only what it owns outright: fees taken at cash-out, funding and refills. Yield of open Positions is
/// never the Treasury's, because a rate fall can erase it. At Unlock a Position's leftover shares move into T and the
/// unpaid yield is recorded as `owedShares` for the Gema holders, fixed in shares at the Unlock rate: a slash after
/// Unlock is carried by the holders (founder decision D2, 2026-10-20), never by the Principal or by open Positions.
/// `poolOwedShares` is the Leaderboard Pool's part of the fees taken (and of the Treasury's refills); `reservedShares`
/// is a zero slot.
/// SimLST vaults (`yieldMinter != 0`, flat rate, shares minted on payout) keep the underlying-unit accounting:
///   Treasury = realisedFees + treasuryCredited - treasuryWithdrawn - instantPaid - the Pool's part.
/// `reportYield(id)` is permissionless and sends `(accrued, treasuryBalance, instantPaid)`: what the vault Treasury can still pay
/// now, the Instant Redeem payouts the vault has made so far (Solana subtracts the payouts it recorded that this count does not include yet) and the block time, so Solana can tell a newer snapshot from an older one. An Instant Redeem payout the Treasury cannot cover reverts and waits: the same message pays once the Treasury holds enough.
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
    uint8 public constant MSG_CASH_IN_BATCH = 6;
    uint8 public constant MSG_PAY_PRIZE = 7;
    uint8 public constant MSG_BATCH_RESULT = 8;
    uint8 public constant MSG_PAY_PRIZE_RESULT = 9;
    uint8 public constant KIND_PLATFORM = 0;
    uint8 public constant KIND_STUDIO = 1;
    uint8 public constant KIND_LEADERBOARD = 2;
    uint8 public constant MAX_BATCH_ENTRIES = 8;
    uint8 public constant PRIZE_PAID = 1;
    uint8 public constant PRIZE_REJECTED = 2;

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
        uint8 horizonMonths;
        bool unlocked;
    }

    /// @dev One entry of a cash-in batch: what Solana asked for, what has been paid so far, and the part of this
    ///      Position's yield held back for it (`reservedUnits`).
    struct BatchEntry {
        uint64 positionId;
        uint128 requested;
        uint128 paid;
        uint128 reserved;
    }

    /// @dev Persistent execution receipt of a cash-in batch. `digest` binds the batch id to its content.
    struct Batch {
        bool exists;
        uint8 kind;
        bytes32 recipient;
        bytes32 digest;
        BatchEntry[] entries;
    }

    /// @dev Persistent receipt of a prize payout. `status` 0 = never seen, 1 = paid, 2 = rejected (never pays).
    struct Payout {
        uint8 status;
        uint128 shares;
        bytes32 digest;
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

    /// @notice Sum of principalUnderlying over open Positions: the shares that back it are never spent on payouts.
    uint256 public openPrincipalUnderlying;
    /// @notice SimLST vaults only: cumulative Yield Fee taken at cash-out, in underlying.
    uint256 public realisedFees;
    /// @notice SimLST vaults only: cumulative underlying of the fees (and refills) that Solana named as owed to the Pool.
    uint256 public poolAccruedUnits;
    /// @notice SimLST vaults only: cumulative underlying added by `fundTreasury` and by refills (PayYield to the vault).
    uint256 public treasuryCredited;
    /// @notice SimLST vaults only: cumulative underlying taken by `withdrawTreasury`.
    uint256 public treasuryWithdrawn;
    /// @notice Real-LST vaults: shares the Treasury owns (T). It holds fees of unlocked Positions, funding, refills,
    ///         and the shares behind the yield owed to Gema holders of unlocked Positions (`owedShares`).
    uint256 public treasuryShares;
    /// @notice Real-LST vaults: shares the open Positions still hold (Principal plus their unpaid yield and fee).
    ///         Everything else the vault holds is the Treasury's (`treasuryShares`).
    uint256 public openHeldShares;
    /// @notice Real-LST vaults: shares owed to Gema holders of unlocked Positions (sum of `owedSharesOf`).
    uint256 public owedShares;
    /// @notice Real-LST vaults: shares owed to the Leaderboard Pool, as named by Solana in each PayYield.
    ///         They sit inside T and no Treasury spending touches them; `fundPrizeEscrow` moves them into the escrow.
    uint256 public poolOwedShares;
    /// @notice SimLST vaults: cumulative underlying of the Pool's part already moved into the escrow.
    uint256 public poolFundedUnits;
    /// @notice Shares reserved for pending payouts. Always zero: every payout executes in the transaction that
    ///         receives it (kept so `spendableTreasuryShares` has one formula).
    uint256 public reservedShares;
    /// @notice Shares in the prize escrow now. Real vaults: they sit inside T as a claim only PayPrize can spend.
    ///         SimLST vaults: minted into the vault and held back from every other payout.
    uint256 public escrowShares;
    /// @notice Cumulative shares that ever entered the escrow (a Leaderboard batch or `fundPrizeEscrow`). Only grows.
    uint256 public escrowedShares;
    /// @notice Cumulative underlying value of those shares at the moment each arrived. Only grows.
    uint256 public escrowedUnits;
    /// @notice Account allowed to call `fundPrizeEscrow` besides the admin (the keeper).
    address public escrowKeeper;
    /// @notice Yield of a Position promised to batches that are not fully paid yet, in underlying.
    mapping(uint64 => uint256) public reservedUnits;
    mapping(uint64 => Batch) internal _batches;
    mapping(uint64 => Payout) public payouts;
    /// @notice Shares still owed to the Gema holders of an unlocked Position (real-LST vaults).
    mapping(uint64 => uint256) public owedSharesOf;
    /// @notice The rate at Unlock, which converts the holders' underlying claim into those shares.
    mapping(uint64 => uint256) public unlockRate;
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
        uint64 indexed positionId,
        uint256 cumulativeAccrued,
        uint256 rate,
        uint64 seq,
        uint256 treasuryBalance,
        uint256 instantPaid
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
    event YieldMinted(uint256 shares);
    event BatchExecuted(uint64 indexed batchId, uint8 kind, uint256 paidUnits, bool complete);
    event BatchIgnored(uint64 indexed batchId, string reason);
    event PrizeEscrowed(uint256 shares, uint256 units, bool fromBatch);
    event PrizePaid(uint64 indexed payoutId, address indexed to, uint256 shares);
    event PrizeRejected(uint64 indexed payoutId, string reason);
    event EscrowKeeperSet(address keeper);
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
    error NotAdminOrKeeper();
    error EscrowTooSmall(uint256 requested, uint256 available);
    error BadFeeSplit(uint256 amount, uint256 fee, uint256 pool);
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
        // tesoro_core keeps Principal as u64; a larger Position could never open on Solana and never unlock.
        if (p.principalUnderlying > type(uint64).max) revert PrincipalTooLarge();
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
        uint256 accrued = _accrued(p);
        if (accrued < reportedAccrued[id]) revert YieldBelowReported(accrued, reportedAccrued[id]);
        reportedAccrued[id] = accrued;
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
            if (msgType == MSG_CASH_IN_BATCH) {
                (,,,, uint8 kind, bytes32 recipient, uint64[] memory ids, uint128[] memory units) =
                    abi.decode(payload, (uint8, uint32, uint64, uint64, uint8, bytes32, uint64[], uint128[]));
                return _onCashInBatch(id, kind, recipient, ids, units);
            }
            (,,,, bytes32 asset, bytes32 prizeSource, bytes32 to, uint256 shares) =
                abi.decode(payload, (uint8, uint32, uint64, uint64, bytes32, bytes32, bytes32, uint256));
            return _onPayPrize(id, asset, prizeSource, to, shares);
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

    /// @dev `amount` leaves the Position's yield; `fee` of it stays with the Treasury and the holder gets the rest.
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
        if (fee > amount || pool > amount) revert BadFeeSplit(amount, fee, pool);
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

    /// @dev Takes `amount` of a Position's yield: records it as paid, converts it to shares and removes the Position's
    ///      claim on them (held shares of an open Position, `owedSharesOf` of an unlocked one). The caller decides
    ///      where the shares go.
    function _debitYield(uint64 id, Position storage p, uint256 amount)
        internal
        returns (uint256 shares, bool settled)
    {
        p.paidUnderlying += amount;
        settled = _real() && p.unlocked;
        // An unlocked Position's holders are owed shares fixed at the Unlock rate; otherwise the live rate.
        shares = (amount * RATE_SCALE) / (settled ? unlockRate[id] : rateSource.underlyingPerShare());
        if (settled) {
            uint256 owed = owedSharesOf[id];
            if (shares > owed) revert InsufficientShares(shares, owed);
            owedSharesOf[id] = owed - shares;
            owedShares -= shares;
        } else {
            _recordPayout(p, shares, amount);
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

    /// @dev Executes a batch from Solana: pays each named Position's yield (the same rules as PayYield, capped at
    ///      what that Position can pay now), to `recipient` (kinds 0 and 1) or into the prize escrow (kind 2), then
    ///      acknowledges with the CUMULATIVE paid amounts. It never reverts for a shortfall: what could not be paid stays
    ///      reserved on its Position and the same batch, delivered again, pays it as yield and shares allow. A batch is
    ///      keyed by its id; a delivery whose content differs from the stored one is ignored.
    function _onCashInBatch(uint64 batchId, uint8 kind, bytes32 recipient, uint64[] memory ids, uint128[] memory units)
        internal
    {
        if (kind > KIND_LEADERBOARD || ids.length == 0 || ids.length > MAX_BATCH_ENTRIES || ids.length != units.length)
        {
            return _ignoreBatch(batchId, "malformed");
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
            return _ignoreBatch(batchId, "content differs from the stored batch");
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
        _sendAck(_batchResult(batchId));
    }

    function _ignoreBatch(uint64 batchId, string memory reason) internal {
        emit BatchIgnored(batchId, reason);
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
    ///      rate); unbounded otherwise.
    function _owedCap(uint64 pid) internal view returns (uint256) {
        if (!_real() || !_positions[pid].unlocked) return type(uint256).max;
        return (owedSharesOf[pid] * unlockRate[pid]) / RATE_SCALE;
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

    /// @dev Shares reach the escrow: counters rise (cumulative), `escrowShares` is the live balance.
    function _addEscrow(uint256 shares, uint256 units, bool fromBatch) internal {
        escrowShares += shares;
        escrowedShares += shares;
        escrowedUnits += units;
        emit PrizeEscrowed(shares, units, fromBatch);
    }

    /// @dev SimLST vaults: yield is minted only when it is paid; escrowed yield is paid into the vault itself.
    function _mintToEscrow(uint256 shares) internal {
        if (shares == 0) return;
        IYieldMinter(yieldMinter).mint(address(this), shares);
        emit YieldMinted(shares);
    }

    function _batchResult(uint64 batchId) internal view returns (bytes memory) {
        Batch storage b = _batches[batchId];
        uint128[] memory paid = new uint128[](b.entries.length);
        for (uint256 i; i < paid.length; i++) {
            paid[i] = b.entries[i].paid;
        }
        return abi.encode(MSG_BATCH_RESULT, sourceChain, batchId, uint64(0), paid, escrowedShares, escrowedUnits);
    }

    /// @dev Pays a prize from the escrow, once per payout id, to `to`. It debits only the escrow, so it works with an
    ///      empty Treasury. A payout that can never pay is recorded as rejected and never pays later; the answer
    ///      (1 paid / 2 rejected) is regenerated on every delivery.
    function _onPayPrize(uint64 payoutId, bytes32 asset, bytes32 prizeSource, bytes32 recipient, uint256 shares)
        internal
    {
        Payout storage r = payouts[payoutId];
        bytes32 digest = keccak256(abi.encode(asset, prizeSource, recipient, shares));
        if (r.status != 0) {
            if (r.digest != digest) emit PrizeRejected(payoutId, "content differs from the stored payout");
            else _sendAck(_payoutResult(payoutId));
            return;
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
        _sendAck(_payoutResult(payoutId));
    }

    function _payoutResult(uint64 payoutId) internal view returns (bytes memory) {
        Payout storage r = payouts[payoutId];
        return abi.encode(MSG_PAY_PRIZE_RESULT, sourceChain, payoutId, uint64(0), r.status, r.shares);
    }

    function _tryTransfer(address to, uint256 shares) internal returns (bool) {
        (bool ok, bytes memory ret) =
            address(lst).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, shares));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @dev A bytes32 word holding a padded EVM address; false when the high 12 bytes are not zero or it is zero.
    function _wallet(bytes32 word) internal pure returns (address a, bool ok) {
        a = address(uint160(uint256(word)));
        ok = uint256(word) >> 160 == 0 && a != address(0);
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

    function _ignore(uint64 id, uint8 msgType, uint64 seq, string memory reason) internal {
        emit MessageIgnored(id, msgType, seq, reason);
    }

    // ---------------------------------------------------------------- math

    function _real() internal view returns (bool) {
        return yieldMinter == address(0);
    }

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

    /// @dev Stores the Position's linear coefficients.
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
            openHeldShares += a;
        }
        p.a = a;
        p.b = b;
        openPrincipalUnderlying += pu;
    }

    function _close(Position storage p) internal {
        openPrincipalUnderlying -= p.principalUnderlying;
    }

    /// @dev The Position's yield at clock `x`; zero if the rate fell below its open rate.
    function _gross(Position storage p, uint256 x) internal view returns (uint256) {
        uint256 hi = p.a * x + p.d;
        return hi > p.b ? (hi - p.b) / _den() : 0;
    }

    /// @dev Cumulative Accrued Yield (gross, no fee), frozen at Unlock.
    function _accrued(Position storage p) internal view returns (uint256) {
        return p.unlocked ? p.frozenAccrued : _gross(p, _clock());
    }

    /// @dev Real LSTs: shares that leave the Position stop earning, so move their value from heldShares to the paid
    ///      total. Yield (heldShares * rate + paid - Principal) is unchanged by the move. After Unlock the
    ///      Position is frozen and out of the sums.
    function _recordPayout(Position storage p, uint256 shares, uint256 amount) internal {
        if (yieldMinter != address(0) || p.unlocked) return;
        p.a -= shares;
        p.heldShares -= shares;
        openHeldShares -= shares;
        p.d += amount * RATE_SCALE;
    }

    /// @dev Shares a real-LST vault may pay out: its balance minus what open Positions hold. Each Position's own
    ///      shares back its own Principal (a payout from them is bounded by the yield formula), so a rate fall below
    ///      one Position's open rate never freezes the Treasury's payouts to unlocked holders.
    function _spendable() internal view returns (uint256) {
        if (yieldMinter != address(0)) return type(uint256).max; // short shares are minted
        uint256 bal = lst.balanceOf(address(this));
        return bal > openHeldShares ? bal - openHeldShares : 0;
    }

    function _reserve() internal view returns (uint256) {
        uint256 rate = rateSource.underlyingPerShare();
        return (openPrincipalUnderlying * RATE_SCALE + rate - 1) / rate + escrowShares;
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
