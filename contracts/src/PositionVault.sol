// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRateSource, IERC20Minimal, IMessageEndpoint} from "./IRateSource.sol";

/// @title PositionVault
/// @notice Holds a Position's Principal in an LST and reports its yield to Solana, where Gemas and Debt live.
///
/// Accounting (rate = underlying per share, 1e18-scaled):
///  - principalShares (P) and principalUnderlying (Pu = P * openRate) are fixed at open.
///  - cumulative accrued yield = P * (rate - openRate), frozen at Unlock. Paid yield is tracked in underlying.
///  - held shares back both the Principal (worth Pu at the current rate) and unpaid yield. Yield is paid out of
///    the held shares above the Principal reserve, so Principal shares leave the vault only through Unlock.
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

    uint64 public nextPositionId;
    mapping(uint64 => Position) internal _positions;
    /// @dev Inbound seqs already processed, per position. Delivery order is not guaranteed by the transport
    ///      (LayerZero executes verified messages in any order and retries reverted ones), so idempotency is
    ///      per seq, not "strictly increasing".
    mapping(uint64 => mapping(uint64 => bool)) internal _handled;

    event PositionLocked(
        uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq
    );
    event YieldAccrued(uint64 indexed positionId, uint256 cumulativeAccrued, uint256 rate, uint64 seq);
    event PositionUnlocked(uint64 indexed positionId, address indexed owner, uint256 sharesReleased, uint64 seq);
    event YieldPaid(
        uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq
    );
    event MessageIgnored(uint64 indexed positionId, uint8 msgType, uint64 seq, string reason);

    error NotEndpoint();
    error BadHorizon();
    error ZeroAmount();
    error UnknownPosition();
    error UnknownMessage();
    error TransferFailed();
    error ExceedsAccruedYield(uint256 requested, uint256 available);

    constructor(address lst_, address rateSource_, address endpoint_, uint32 sourceChain_) {
        lst = IERC20Minimal(lst_);
        rateSource = IRateSource(rateSource_);
        messageEndpoint = endpoint_;
        sourceChain = sourceChain_;
    }

    // ---------------------------------------------------------------- views

    function getPosition(uint64 id) external view returns (Position memory) {
        return _positions[id];
    }

    function accruedYield(uint64 id) public view returns (uint256) {
        return _accrued(_positions[id], rateSource.underlyingPerShare());
    }

    function payableYield(uint64 id) public view returns (uint256) {
        Position storage p = _positions[id];
        uint256 accrued = _accrued(p, rateSource.underlyingPerShare());
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
        p.openRate = rate;
        p.heldShares = lstAmount;
        p.openTime = uint64(block.timestamp);
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
        uint256 rate = rateSource.underlyingPerShare();
        uint256 accrued = _accrued(p, rate);
        uint64 seq = ++p.outSeq;
        emit YieldAccrued(id, accrued, rate, seq);
        _send(abi.encode(MSG_YIELD_ACCRUED, sourceChain, id, seq, accrued, rate, block.timestamp));
    }

    // ---------------------------------------------------------------- inbound

    /// @notice Only the messaging endpoint may deliver. A LayerZero subclass calls `_receive` directly instead.
    function receiveMessage(bytes calldata payload) external {
        if (msg.sender != messageEndpoint) revert NotEndpoint();
        _receive(payload);
    }

    function _receive(bytes memory payload) internal virtual {
        (uint8 msgType, uint32 chain, uint64 id, uint64 seq) = abi.decode(payload, (uint8, uint32, uint64, uint64));
        if (msgType != MSG_UNLOCK && msgType != MSG_PAY_YIELD) revert UnknownMessage();

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
            _onPayYield(id, p, seq, address(uint160(uint256(to))), amount);
        }
    }

    /// @dev Releases Principal (worth principalUnderlying at the current rate) to the owner. Unpaid yield stays
    ///      in the vault, frozen, for redeemers.
    function _onUnlock(uint64 id, Position storage p, uint64 seq) internal {
        if (p.unlocked) return _ignore(id, MSG_UNLOCK, seq, "already unlocked");
        uint256 rate = rateSource.underlyingPerShare();
        p.frozenAccrued = _accrued(p, rate);
        p.unlocked = true;

        uint256 release = _principalReserve(p, rate);
        p.heldShares -= release;
        if (!lst.transfer(p.owner, release)) revert TransferFailed();
        emit PositionUnlocked(id, p.owner, release, seq);
    }

    function _onPayYield(uint64 id, Position storage p, uint64 seq, address to, uint256 amount) internal {
        uint256 rate = rateSource.underlyingPerShare();
        uint256 accrued = _accrued(p, rate);
        uint256 available = accrued > p.paidUnderlying ? accrued - p.paidUnderlying : 0;
        if (amount > available) revert ExceedsAccruedYield(amount, available);

        uint256 reserve = p.unlocked ? 0 : _principalReserve(p, rate);
        uint256 spendable = p.heldShares > reserve ? p.heldShares - reserve : 0;
        uint256 shares = (amount * RATE_SCALE + rate - 1) / rate; // round up in the vault's favour
        if (shares > spendable) shares = spendable; // dust; Principal is never touched

        p.paidUnderlying += amount;
        p.heldShares -= shares;
        if (!lst.transfer(to, shares)) revert TransferFailed();
        emit YieldPaid(id, to, amount, shares, seq);
    }

    function _ignore(uint64 id, uint8 msgType, uint64 seq, string memory reason) internal {
        emit MessageIgnored(id, msgType, seq, reason);
    }

    // ---------------------------------------------------------------- math

    function _accrued(Position storage p, uint256 rate) internal view returns (uint256) {
        if (p.unlocked) return p.frozenAccrued;
        if (rate <= p.openRate) return 0;
        return (p.principalShares * (rate - p.openRate)) / RATE_SCALE;
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
