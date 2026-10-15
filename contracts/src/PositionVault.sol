// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IERC20Minimal, IMessageEndpoint, IYieldMinter} from "./IRateSource.sol";

/// @title PositionVault
/// @notice Holds a Position's Principal in an LST and reports its yield to Solana, where Gemas and Debt live.
///
/// Accounting (rate = underlying per share, 1e18-scaled):
///  - principalShares (P) and principalUnderlying (Pu = P * openRate) are fixed at open.
///  - held shares back both the Principal (worth Pu at the current rate) and unpaid yield. Yield is paid out of
///    the held shares above the Principal reserve, so Principal shares leave the vault only through Unlock.
///  - cumulative accrued yield = paid + value of the held shares above the Principal reserve, frozen at Unlock.
///    Shares already paid out stop earning here, so every unpaid unit of accrued yield is backed by held shares
///    and a PayYield within it is paid in full.
///
/// Simulated yield (docs/yield-model.md): when `yieldMinter` is a SimLST, each Position earns
/// principalUnderlying * apyBps * simElapsed / (BPS * YEAR) linearly from its open time, minted as shares into this
/// vault by `accrue`. The rate is constant, so the accounting above is unchanged. With `yieldMinter == address(0)`
/// (real wstETH) yield comes from the rate only.
///
/// Yield Fee: `yieldFeeBps` of every simulated yield mint goes to the Treasury instead of the Position, so only
/// the rest counts as the Position's accrued yield. Instant Redeems are paid out of the Treasury (see
/// `_onPayInstant`); a PayYield addressed to the vault itself refills it. Rate-based vaults (real wstETH) mint
/// nothing: `_accrue` instead moves `yieldFeeBps` of the rate growth since the last accrual from the Position's
/// spare shares to the Treasury, so the fee is taken at the source and the 77-byte report is unchanged.
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
        uint256 heldShares;
        uint256 paidUnderlying;
        uint256 frozenAccrued;
        uint64 openTime;
        uint64 outSeq;
        uint64 inSeq;
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
    /// @notice Account allowed to set the Yield Fee and fund the Treasury (the deployer; the owner in the OApp).
    address public immutable admin = msg.sender;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @notice Share of each simulated yield mint kept by the Treasury, in basis points.
    uint16 public yieldFeeBps = 2000;
    /// @notice LST shares held for the Treasury, separate from every Position's heldShares.
    uint256 public treasuryShares;
    /// @notice Cumulative underlying ever credited to the Treasury (fees, funding, refills). Monotonic: Solana caps
    ///         Instant Redeems against it.
    uint256 public treasuryIn;
    /// @notice Cumulative underlying paid out by Instant Redeem.
    uint256 public instantPaid;

    /// @notice Rate-based vaults: gross yield (paid + fee taken + spare value) the Yield Fee has been assessed on, per
    ///         position. A high-water mark: a fall in the rate charges nothing until it is recovered.
    mapping(uint64 => uint256) public feeAssessed;
    /// @notice Rate-based vaults: cumulative underlying moved to the Treasury as Yield Fee, per position.
    mapping(uint64 => uint256) public feeTakenUnderlying;

    /// @notice Last time `accrue` converted time to shares, per position.
    mapping(uint64 => uint64) public lastAccrual;

    uint64 public nextPositionId;
    mapping(uint64 => Position) internal _positions;
    /// @dev Inbound seqs already processed, per position. Delivery order is not guaranteed by the transport
    ///      (LayerZero executes verified messages in any order and retries reverted ones), so idempotency is
    ///      per seq, not "strictly increasing".
    mapping(uint64 => mapping(uint64 => bool)) internal _handled;

    event PositionLocked(
        uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq
    );
    event YieldAccrued(
        uint64 indexed positionId, uint256 cumulativeAccrued, uint256 rate, uint64 seq, uint256 treasuryIn
    );
    event PositionUnlocked(uint64 indexed positionId, address indexed owner, uint256 sharesReleased, uint64 seq);
    event YieldPaid(
        uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq
    );
    event YieldFeeTaken(uint64 indexed positionId, uint256 shares, uint256 underlying);
    event TreasuryFunded(address indexed from, uint256 shares, uint256 underlying);
    event TreasuryRefilled(uint64 indexed positionId, uint256 amountUnderlying, uint256 shares, uint64 seq);
    event InstantPaid(
        uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq
    );
    event YieldFeeSet(uint16 bps);
    event YieldMinted(uint64 indexed positionId, uint256 shares, uint256 underlying);
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

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_, address yieldMinter_) {
        lst = IERC20Minimal(lst_);
        rateSource = IRateSource(rateSource_);
        messageEndpoint = endpoint_;
        sourceChain = sourceChain_;
        yieldMinter = yieldMinter_;
    }

    // ---------------------------------------------------------------- admin

    function setYieldFeeBps(uint16 bps) external {
        _checkAdmin();
        if (bps > MAX_YIELD_FEE_BPS) revert FeeTooHigh();
        yieldFeeBps = bps;
        emit YieldFeeSet(bps);
    }

    /// @notice Moves LST shares from the admin into the Treasury. There is deliberately no way to withdraw: Solana
    ///         caps Instant Redeems against `treasuryIn`, which is only safe while it never decreases and nothing
    ///         but Instant Redeem spends the Treasury.
    function fundTreasury(uint256 shares) external {
        _checkAdmin();
        if (shares == 0) revert ZeroAmount();
        if (!lst.transferFrom(msg.sender, address(this), shares)) revert TransferFailed();
        uint256 underlying = _value(shares, rateSource.underlyingPerShare());
        treasuryShares += shares;
        treasuryIn += underlying;
        emit TreasuryFunded(msg.sender, shares, underlying);
    }

    function _checkAdmin() internal view virtual {
        if (msg.sender != admin) revert NotAdmin();
    }

    // ---------------------------------------------------------------- views

    /// @notice Underlying value of the Treasury's shares at the current rate.
    function treasuryBalance() external view returns (uint256) {
        return _value(treasuryShares, rateSource.underlyingPerShare());
    }

    function getPosition(uint64 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Cumulative accrued yield including what `accrue` would mint right now.
    function accruedYield(uint64 id) public view returns (uint256) {
        Position storage p = _positions[id];
        return _accruedWithPending(id, p, rateSource.underlyingPerShare());
    }

    function payableYield(uint64 id) public view returns (uint256) {
        Position storage p = _positions[id];
        uint256 accrued = _accruedWithPending(id, p, rateSource.underlyingPerShare());
        return accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
    }

    // ---------------------------------------------------------------- outbound

    function openPosition(uint256 lstAmount, uint8 horizonMonths) external payable returns (uint64 id) {
        if (lstAmount == 0) revert ZeroAmount();
        if (horizonMonths < 1 || horizonMonths > 12) revert BadHorizon();

        uint256 rate = rateSource.underlyingPerShare();
        id = ++nextPositionId;
        Position storage p = _positions[id];
        p.owner = msg.sender;
        p.principalShares = lstAmount;
        p.principalUnderlying = (lstAmount * rate) / RATE_SCALE;
        // tesoro_core keeps Principal as u64; a larger Position could never open on Solana and never unlock.
        if (p.principalUnderlying > type(uint64).max) revert PrincipalTooLarge();
        p.openRate = rate;
        p.heldShares = lstAmount;
        p.openTime = uint64(block.timestamp);
        lastAccrual[id] = uint64(block.timestamp);
        p.horizonMonths = horizonMonths;
        uint64 seq = ++p.outSeq;

        if (!lst.transferFrom(msg.sender, address(this), lstAmount)) revert TransferFailed();

        emit PositionLocked(id, msg.sender, lstAmount, horizonMonths, seq);
        _send(
            abi.encode(
                MSG_POSITION_LOCKED,
                sourceChain,
                id,
                seq,
                bytes32(uint256(uint160(msg.sender))),
                bytes32(uint256(uint160(address(lst)))),
                lstAmount,
                p.principalUnderlying,
                rate,
                horizonMonths
            )
        );
    }

    /// @notice Permissionless (keeper-friendly): reports cumulative accrued yield in underlying units.
    ///         Payable: a LayerZero subclass charges the caller the message fee (see PositionVaultOApp).
    function reportYield(uint64 id) external payable {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        _accrue(id, p);
        uint256 rate = rateSource.underlyingPerShare();
        uint256 accrued = _accrued(p, rate);
        uint64 seq = ++p.outSeq;
        emit YieldAccrued(id, accrued, rate, seq, treasuryIn);
        _send(abi.encode(MSG_YIELD_ACCRUED, sourceChain, id, seq, accrued, rate, block.timestamp, treasuryIn));
    }

    /// @notice Permissionless: mints the simulated yield earned since the last accrual into the vault.
    function accrue(uint64 id) external {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        _accrue(id, p);
    }

    /// @dev Gross simulated yield since the last accrual, before the Yield Fee. No-op for rate-based LSTs and
    ///      after Unlock.
    function _pending(uint64 id, Position storage p) internal view returns (uint256 shares, uint256 underlying) {
        if (yieldMinter == address(0) || p.unlocked) return (0, 0);
        uint256 dt = block.timestamp - lastAccrual[id];
        if (dt == 0) return (0, 0);
        IYieldMinter m = IYieldMinter(yieldMinter);
        underlying = (p.principalUnderlying * m.apyBps() * dt * m.speedup()) / (BPS * YEAR);
        shares = (underlying * RATE_SCALE) / rateSource.underlyingPerShare();
    }

    function _accruedWithPending(uint64 id, Position storage p, uint256 rate) internal view returns (uint256) {
        if (p.unlocked) return p.frozenAccrued;
        (uint256 shares,) = _pending(id, p);
        uint256 held = p.heldShares + (shares - _fee(shares));
        if (yieldMinter == address(0)) (held,) = _afterRateFee(id, p, rate);
        uint256 reserve = _principalReserve(p, rate);
        reserve = reserve > held ? held : reserve;
        return p.paidUnderlying + ((held - reserve) * rate) / RATE_SCALE;
    }

    function _fee(uint256 shares) internal view returns (uint256) {
        return (shares * yieldFeeBps) / BPS;
    }

    /// @dev Mints the gross yield into the vault and splits it: the Yield Fee to the Treasury, the rest to the
    ///      Position. If the Position's part is worth less than one share the timestamp is kept so the time
    ///      carries over.
    function _accrue(uint64 id, Position storage p) internal {
        if (yieldMinter == address(0)) return _accrueRate(id, p);
        (uint256 shares, uint256 underlying) = _pending(id, p);
        uint256 feeShares = _fee(shares);
        if (shares - feeShares == 0) return;
        lastAccrual[id] = uint64(block.timestamp);
        p.heldShares += shares - feeShares;
        IYieldMinter(yieldMinter).mint(address(this), shares);
        emit YieldMinted(id, shares, underlying);
        if (feeShares > 0) {
            uint256 feeUnderlying = _value(feeShares, rateSource.underlyingPerShare());
            treasuryShares += feeShares;
            treasuryIn += feeUnderlying;
            emit YieldFeeTaken(id, feeShares, feeUnderlying);
        }
    }

    /// @dev Held shares after the Yield Fee on the rate growth not yet assessed, and the fee shares themselves.
    ///      Gross yield G = paid + fee taken + value of the held shares above the Principal reserve.
    function _afterRateFee(uint64 id, Position storage p, uint256 rate)
        internal
        view
        returns (uint256 held, uint256 feeShares)
    {
        held = p.heldShares;
        if (p.unlocked || yieldFeeBps == 0) return (held, 0);
        uint256 reserve = _principalReserve(p, rate);
        uint256 spare = held - reserve;
        uint256 gross = p.paidUnderlying + feeTakenUnderlying[id] + _value(spare, rate);
        uint256 assessed = feeAssessed[id];
        if (gross <= assessed) return (held, 0);
        feeShares = (((gross - assessed) * yieldFeeBps) / BPS * RATE_SCALE) / rate;
        if (feeShares > spare) feeShares = spare;
        held -= feeShares;
    }

    /// @dev Rate-based accrual: moves the Yield Fee on new rate growth from the Position to the Treasury.
    function _accrueRate(uint64 id, Position storage p) internal {
        if (p.unlocked) return;
        uint256 rate = rateSource.underlyingPerShare();
        (uint256 held, uint256 feeShares) = _afterRateFee(id, p, rate);
        if (feeShares == 0) {
            // Nothing to charge; still ratchet the mark so a fee-free stretch is not charged later.
            uint256 g = p.paidUnderlying + feeTakenUnderlying[id] + _value(held - _principalReserve(p, rate), rate);
            if (g > feeAssessed[id] && yieldFeeBps == 0) feeAssessed[id] = g;
            return;
        }
        uint256 feeUnderlying = _value(feeShares, rate);
        p.heldShares = held;
        treasuryShares += feeShares;
        treasuryIn += feeUnderlying;
        feeTakenUnderlying[id] += feeUnderlying;
        feeAssessed[id] = p.paidUnderlying + feeTakenUnderlying[id] + _value(held - _principalReserve(p, rate), rate);
        emit YieldFeeTaken(id, feeShares, feeUnderlying);
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

    /// @dev Releases Principal (worth principalUnderlying at the current rate) to the owner. Unpaid yield stays
    ///      in the vault, frozen, for redeemers.
    function _onUnlock(uint64 id, Position storage p, uint64 seq) internal {
        if (p.unlocked) return _ignore(id, MSG_UNLOCK, seq, "already unlocked");
        _accrue(id, p);
        uint256 rate = rateSource.underlyingPerShare();
        p.frozenAccrued = _accrued(p, rate);
        p.unlocked = true;

        uint256 release = _principalReserve(p, rate);
        p.heldShares -= release;
        if (!lst.transfer(p.owner, release)) revert TransferFailed();
        emit PositionUnlocked(id, p.owner, release, seq);
    }

    function _onPayYield(uint64 id, Position storage p, uint64 seq, address to, uint256 amount) internal {
        _accrue(id, p);
        uint256 rate = rateSource.underlyingPerShare();
        uint256 accrued = _accrued(p, rate);
        uint256 available = accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
        if (amount > available) revert ExceedsAccruedYield(amount, available);

        uint256 reserve = p.unlocked ? 0 : _principalReserve(p, rate);
        uint256 spendable = p.heldShares > reserve ? p.heldShares - reserve : 0;
        // Rounded down (less than one share-wei of value): paying never lowers the reported cumulative, which
        // tesoro_core refuses (CumulativeDecreased).
        uint256 shares = (amount * RATE_SCALE) / rate;
        // Only reachable after Unlock with a fallen rate. Reverting keeps the message retryable (see F-13)
        // instead of paying less than the claim and recording it as paid.
        if (shares > spendable) revert InsufficientShares(shares, spendable);

        p.paidUnderlying += amount;
        p.heldShares -= shares;
        if (to == address(this)) {
            // Tesoro redeemed the Gemas it bought with Instant Redeems: the yield goes back to the Treasury.
            treasuryShares += shares;
            treasuryIn += _value(shares, rate);
            emit TreasuryRefilled(id, amount, shares, seq);
            return;
        }
        if (!lst.transfer(to, shares)) revert TransferFailed();
        emit YieldPaid(id, to, amount, shares, seq);
    }

    /// @dev Pays `amount` underlying out of the Treasury, independent of the Position's own shares and lock state.
    ///      Reverting when short keeps the message retryable, like `_onPayYield`.
    function _onPayInstant(uint64 id, uint64 seq, address to, uint256 amount) internal {
        uint256 shares = (amount * RATE_SCALE) / rateSource.underlyingPerShare();
        if (shares > treasuryShares) revert InsufficientTreasury(shares, treasuryShares);
        treasuryShares -= shares;
        instantPaid += amount;
        if (!lst.transfer(to, shares)) revert TransferFailed();
        emit InstantPaid(id, to, amount, shares, seq);
    }

    function _ignore(uint64 id, uint8 msgType, uint64 seq, string memory reason) internal {
        emit MessageIgnored(id, msgType, seq, reason);
    }

    // ---------------------------------------------------------------- math

    function _value(uint256 shares, uint256 rate) internal pure returns (uint256) {
        return (shares * rate) / RATE_SCALE;
    }

    function _accrued(Position storage p, uint256 rate) internal view returns (uint256) {
        if (p.unlocked) return p.frozenAccrued;
        uint256 spare = p.heldShares - _principalReserve(p, rate);
        return p.paidUnderlying + (spare * rate) / RATE_SCALE;
    }

    /// @dev Shares worth principalUnderlying at `rate`, capped by what is held.
    function _principalReserve(Position storage p, uint256 rate) internal view returns (uint256) {
        uint256 shares = (p.principalUnderlying * RATE_SCALE + rate - 1) / rate;
        return shares > p.heldShares ? p.heldShares : shares;
    }

    // ---------------------------------------------------------------- transport seam

    /// @dev Override to send through LayerZero. Default: the configured endpoint.
    function _send(bytes memory payload) internal virtual {
        IMessageEndpoint(messageEndpoint).send(payload);
    }
}
