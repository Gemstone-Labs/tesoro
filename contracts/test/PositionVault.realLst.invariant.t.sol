// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {RateToken} from "./MainnetVault.t.sol";

/// Real-LST vault (rate source, no yield minter) driven through random opens, rate moves from -10% to +5%
/// (slashes), funding, owner withdrawals of `treasuryBalance()`, Instant Redeems, PayYield to players and to the
/// vault, Unlocks and reports.
contract RealLstHandler is Test {
    uint32 constant CHAIN = 7;
    RateToken public tok;
    PositionVault public vault;
    MockEndpoint public ep;
    address public user = address(0xA11CE);
    address public redeemer = address(0xEDEE);

    uint64[] public ids;
    mapping(uint64 => uint64) public nextSeq;
    /// ghost: yield was paid out of this open Position (to a player or back to the vault) (audit E-1 exposure: a fall can erase it)
    mapping(uint64 => bool) public paidOut;
    bool public unlockShort;
    uint64 public nextBatch;
    uint64 public nextPayout;
    uint256 public prizeSharesPaid;
    uint256 public lastEscrowedShares;
    uint256 public lastEscrowedUnits;
    bool public escrowCounterFell;
    /// ghost: cumulative paid per (batch, entry) never exceeds requested nor falls
    bool public batchOverpaid;

    constructor() {
        tok = new RateToken();
        ep = new MockEndpoint();
        vault = new PositionVault(
            address(tok), address(new WstETHRateAdapter(address(tok))), address(ep), CHAIN, address(0)
        );
        tok.mint(user, type(uint128).max);
        vm.prank(user);
        tok.approve(address(vault), type(uint256).max);
        tok.approve(address(vault), type(uint256).max);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function open(uint256 amount, uint8 horizon) external {
        amount = bound(amount, 1e6, 3 ether);
        horizon = uint8(bound(horizon, 1, 12));
        vm.prank(user);
        try vault.openPosition(amount, horizon) returns (uint64 id) {
            ids.push(id);
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    /// -10% .. +5%, kept inside [0.3, 5].
    function moveRate(uint256 seed) external {
        uint256 bps = bound(seed, 9000, 10_500);
        uint256 r = tok.stEthPerToken() * bps / 10_000;
        tok.setRate(bound(r, 0.3e18, 5e18));
    }

    function fund(uint256 shares) external {
        shares = bound(shares, 1, 5 ether);
        tok.mint(address(this), shares);
        vault.fundTreasury(shares);
    }

    function withdraw(uint256 pct) external {
        uint256 t = vault.treasuryBalance() * bound(pct, 1, 100) / 100;
        if (t == 0) return;
        vault.withdrawTreasury(t, address(this));
    }

    function instant(uint256 idx, uint256 pct, bool overshoot) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 t = vault.treasuryBalance();
        uint256 amount = overshoot ? t + bound(pct, 1, 1 ether) : t * bound(pct, 0, 100) / 100;
        _deliver(abi.encode(uint8(5), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(redeemer))), amount));
    }

    function payYield(uint256 idx, uint256 pct, bool toVault) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 amount = vault.unreservedYield(id) * bound(pct, 0, 100) / 100;
        address to = toVault ? address(vault) : redeemer;
        bool ok = _deliver(abi.encode(uint8(4), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(to))), amount));
        // a refill to the vault moves the Position's shares out just like a payout to a player
        if (ok && amount > 0 && !vault.getPosition(id).unlocked) paidOut[id] = true;
    }

    function unlock(uint256 idx) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        PositionVault.Position memory p = vault.getPosition(id);
        if (p.unlocked) return;
        uint256 rate = tok.stEthPerToken();
        uint256 needed = (p.principalUnderlying * 1e18 + rate - 1) / rate;
        if (needed > p.principalShares) needed = p.principalShares;
        uint256 before = tok.balanceOf(user);
        bool ok = _deliver(abi.encode(uint8(3), CHAIN, id, ++nextSeq[id]));
        // I2: an Unlock returns the Principal in full unless a player was paid yield the rate has since erased.
        if (ok && !paidOut[id] && tok.balanceOf(user) - before < needed) unlockShort = true;
    }

    /// A Leaderboard (2), Platform (0) or Studio (1) batch over 1..3 Positions, sometimes asking for more than is payable
    /// and sometimes re-delivering an earlier batch id.
    function batch(uint256 seed, uint256 pct, bool resend) external {
        if (ids.length == 0) return;
        uint64 batchId = resend && nextBatch > 0 ? uint64(bound(seed, 1, nextBatch)) : ++nextBatch;
        if (resend && batchId != nextBatch) {
            // re-deliver the stored content exactly
            (bool exists, uint8 bkind, bytes32 recipient, PositionVault.BatchEntry[] memory es) = vault.batchOf(batchId);
            if (!exists) return;
            uint64[] memory bi = new uint64[](es.length);
            uint128[] memory bu = new uint128[](es.length);
            for (uint256 i; i < es.length; i++) {
                bi[i] = es[i].positionId;
                bu[i] = es[i].requested;
            }
            _deliver(abi.encode(uint8(6), CHAIN, batchId, uint64(0), bkind, recipient, bi, bu));
            _checkBatch(batchId);
            return;
        }
        uint256 n = bound(seed >> 8, 1, 3);
        uint64[] memory pi = new uint64[](n);
        uint128[] memory pu = new uint128[](n);
        for (uint256 i; i < n; i++) {
            pi[i] = ids[uint256(keccak256(abi.encode(seed, i))) % ids.length];
            pu[i] = uint128(vault.payableYield(pi[i]) * bound(pct, 0, 200) / 100 + (seed % 3));
        }
        uint8 kind = uint8((seed >> 16) % 3);
        bytes32 to = kind == 2 ? bytes32(0) : bytes32(uint256(uint160(redeemer)));
        _deliver(abi.encode(uint8(6), CHAIN, batchId, uint64(0), kind, to, pi, pu));
        for (uint256 i; i < n; i++) {
            if (!vault.getPosition(pi[i]).unlocked && pu[i] > 0) paidOut[pi[i]] = true;
        }
        _checkBatch(batchId);
    }

    function _checkBatch(uint64 batchId) internal {
        (,,, PositionVault.BatchEntry[] memory es) = vault.batchOf(batchId);
        for (uint256 i; i < es.length; i++) {
            if (es[i].paid > es[i].requested) batchOverpaid = true;
        }
    }

    function fundEscrow() external {
        try vault.fundPrizeEscrow(0) {} catch {}
    }

    function payPrize(uint256 pct) external {
        uint256 shares = vault.escrowShares() * bound(pct, 0, 100) / 100;
        if (shares == 0) return;
        uint256 before = vault.escrowShares();
        _deliver(
            abi.encode(
                uint8(7),
                CHAIN,
                ++nextPayout,
                uint64(0),
                bytes32(uint256(uint160(address(tok)))),
                bytes32(uint256(1)),
                bytes32(uint256(uint160(redeemer))),
                shares
            )
        );
        prizeSharesPaid += before - vault.escrowShares();
    }

    function report(uint256 idx) external {
        if (ids.length == 0) return;
        try vault.reportYield(ids[idx % ids.length]) {} catch {}
    }

    /// I4: every share in the escrow can be paid out in full whatever the Treasury holds, and nothing else moves.
    function escrowAlwaysPaysInFull() external returns (bool) {
        uint256 snap = vm.snapshotState();
        uint256 esc = vault.escrowShares();
        bool ok = true;
        if (esc > 0) {
            uint256 treasuryBefore = vault.treasuryShares();
            uint256 balBefore = tok.balanceOf(address(this));
            uint256 t = vault.treasuryBalance();
            if (t > 0) vault.withdrawTreasury(t, address(0xC0FFEE));
            ok = _deliver(
                abi.encode(
                    uint8(7),
                    CHAIN,
                    uint64(type(uint64).max),
                    uint64(0),
                    bytes32(uint256(uint160(address(tok)))),
                    bytes32(uint256(1)),
                    bytes32(uint256(uint160(address(0xB0B)))),
                    esc
                )
            );
            ok = ok && tok.balanceOf(address(0xB0B)) == esc && vault.escrowShares() == 0;
            treasuryBefore;
            balBefore;
        }
        vm.revertToState(snap);
        return ok;
    }

    function trackEscrow() external {
        if (vault.escrowedShares() < lastEscrowedShares || vault.escrowedUnits() < lastEscrowedUnits) {
            escrowCounterFell = true;
        }
        lastEscrowedShares = vault.escrowedShares();
        lastEscrowedUnits = vault.escrowedUnits();
    }

    function _deliver(bytes memory m) internal returns (bool ok) {
        try ep.deliver(address(vault), m) {
            ok = true;
        } catch {}
    }

    /// I3: the owner withdrawing `treasuryBalance()` never makes a PayYield revert (open or unlocked Positions).
    function withdrawThenEveryClaimIsPayable() external returns (bool) {
        uint256 snap = vm.snapshotState();
        uint256 t = vault.treasuryBalance();
        if (t > 0) vault.withdrawTreasury(t, address(this));
        bool ok = true;
        for (uint256 i; i < ids.length; i++) {
            uint64 id = ids[i];
            uint256 amount = vault.unreservedYield(id);
            if (amount == 0) continue;
            ok = ok
                && _deliver(abi.encode(uint8(4), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(redeemer))), amount));
        }
        vm.revertToState(snap);
        return ok;
    }
}

contract RealLstInvariantTest is Test {
    RealLstHandler h;

    function setUp() public {
        h = new RealLstHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](12);
        sel[0] = h.open.selector;
        sel[1] = h.warp.selector;
        sel[2] = h.moveRate.selector;
        sel[3] = h.fund.selector;
        sel[4] = h.withdraw.selector;
        sel[5] = h.instant.selector;
        sel[6] = h.payYield.selector;
        sel[7] = h.unlock.selector;
        sel[8] = h.batch.selector;
        sel[9] = h.fundEscrow.selector;
        sel[10] = h.payPrize.selector;
        sel[11] = h.trackEscrow.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// I1: the vault holds exactly what open Positions hold plus the Treasury.
    function invariant_I1_accounting() public view {
        PositionVault v = h.vault();
        uint256 held;
        uint256 owed;
        for (uint256 i; i < h.idsLength(); i++) {
            uint64 id = h.ids(i);
            PositionVault.Position memory p = v.getPosition(id);
            held += p.heldShares;
            owed += v.owedSharesOf(id);
            if (p.unlocked) assertEq(p.heldShares, 0);
        }
        assertEq(h.tok().balanceOf(address(v)), held + v.treasuryShares(), "balance = open held + T");
        assertGe(
            v.treasuryShares(),
            v.owedShares() + v.poolOwedShares() + v.escrowShares(),
            "T backs the holders, the Pool and the escrow"
        );
        assertEq(v.openHeldShares(), held);
        assertEq(v.owedShares(), owed);
        assertGe(v.treasuryShares(), v.owedShares(), "the Treasury always holds what it owes");
    }

    /// I5: escrow counters only grow; the escrow balance is what came in minus what prizes paid.
    function invariant_I5_escrowCounters() public {
        PositionVault v = h.vault();
        h.trackEscrow();
        assertFalse(h.escrowCounterFell());
        assertEq(v.escrowedShares() - h.prizeSharesPaid(), v.escrowShares(), "in - paid = balance");
    }

    /// I6: the whole escrow pays out even after the owner withdraws the whole Treasury.
    function invariant_I6_escrowAlwaysPays() public {
        assertTrue(h.escrowAlwaysPaysInFull());
    }

    /// I7: a batch entry is never paid beyond what was requested.
    function invariant_I7_batchesNeverOverpay() public view {
        assertFalse(h.batchOverpaid());
    }

    /// I2: Unlock returned the Principal in full whenever no player was paid yield the rate has since erased.
    function invariant_I2_principalAlwaysComesBack() public view {
        assertFalse(h.unlockShort());
    }

    /// I3: withdrawing the whole spendable Treasury never blocks a claim, open or unlocked.
    function invariant_I3_treasuryCannotHurtPlayers() public {
        assertTrue(h.withdrawThenEveryClaimIsPayable());
    }

    /// The spendable figure never exceeds what the Treasury's shares are worth.
    function invariant_spendableWithinT() public view {
        PositionVault v = h.vault();
        assertLe(v.spendableTreasuryShares(), v.treasuryShares());
        assertEq(v.reservedShares(), 0);
    }
}
