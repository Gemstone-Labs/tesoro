// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IERC20Minimal, IYieldMinter} from "./IRateSource.sol";

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
/// A Yield Report never carries less than an earlier one: after a rate fall it repeats the highest figure sent
/// (`reportedAccrued`), because Solana rejects a lower cumulative, and the Treasury balance and Instant payouts it also
/// carries keep flowing. The Gema holders carry the shortfall (D2).
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
abstract contract PositionVaultBase {
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
    uint256 internal constant BPS = 10_000;
    /// @dev Wei per unit of the 9-decimal amounts tesoro_bridge gives tesoro_core (it rounds every report down to a
    ///      whole unit and asks for whole units back). Vaults hold 18-decimal assets.
    uint256 internal constant CORE_UNIT = 1e9;
    /// @dev tesoro_core's cap on the Yield Fee (ledger::MAX_YIELD_FEE_BPS): a PayYield fee above it is refused.
    uint256 internal constant MAX_YIELD_FEE_BPS = 5_000;
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
    error PrincipalBelowUnit();
    error NotAdmin();
    error NotAdminOrKeeper();
    error EscrowTooSmall(uint256 requested, uint256 available);
    error BadFeeSplit(uint256 amount, uint256 fee, uint256 pool);
    error InsufficientTreasury(uint256 needed, uint256 available);
    /// @dev Solana refuses a cumulative lower than one it applied (CumulativeDecreased); a rate fall can push the
    ///      Accrued Yield under what an earlier report said, so that report waits for the rate to recover.

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_, address yieldMinter_) {
        lst = IERC20Minimal(lst_);
        rateSource = IRateSource(rateSource_);
        messageEndpoint = endpoint_;
        sourceChain = sourceChain_;
        yieldMinter = yieldMinter_;
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

    function _payoutResult(uint64 payoutId) internal view returns (bytes memory) {
        Payout storage r = payouts[payoutId];
        return abi.encode(MSG_PAY_PRIZE_RESULT, sourceChain, payoutId, uint64(0), r.status, r.shares);
    }

    /// @dev A bytes32 word holding a padded EVM address; false when the high 12 bytes are not zero or it is zero.
    function _wallet(bytes32 word) internal pure returns (address a, bool ok) {
        a = address(uint160(uint256(word)));
        ok = uint256(word) >> 160 == 0 && a != address(0);
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
}
