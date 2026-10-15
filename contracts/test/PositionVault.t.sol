// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {IWstETH} from "../src/IRateSource.sol";

contract MockWstETH is IWstETH {
    uint256 public stEthPerToken = 1.03e18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setRate(uint256 r) external {
        stEthPerToken = r;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

abstract contract VaultBase is Test {
    uint32 constant CHAIN = 40449;
    PositionVault vault;
    MockEndpoint ep;
    address alice = address(0xA11CE);
    address redeemer = address(0xEDEE);

    function _unlockMsg(uint64 id, uint64 seq) internal pure returns (bytes memory) {
        return abi.encode(uint8(3), CHAIN, id, seq);
    }

    function _payMsg(uint64 id, uint64 seq, address to, uint256 amt) internal pure returns (bytes memory) {
        return abi.encode(uint8(4), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt);
    }

    function _deliver(bytes memory m) internal {
        ep.deliver(address(vault), m);
    }
}

contract PositionVaultSimTest is VaultBase {
    SimLST lst;

    function setUp() public {
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        ep = new MockEndpoint();
        vault = new PositionVault(address(lst), address(lst), address(ep), CHAIN, address(lst));
        lst.setMinter(address(vault));
        lst.faucet(alice);
        vm.prank(alice);
        lst.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition(amt, 3);
    }

    function test_openLocksAndSendsPositionLocked() public {
        uint64 id = _open(10 ether);
        assertEq(lst.balanceOf(address(vault)), 10 ether);
        assertEq(ep.outboxLength(), 1);
        (uint8 t, uint32 chain, uint64 pid, uint64 seq,,, uint256 shares,,, uint256 horizon) = abi.decode(
            ep.outboxPayload(0), (uint8, uint32, uint64, uint64, bytes32, bytes32, uint256, uint256, uint256, uint256)
        );
        assertEq(t, 1);
        assertEq(chain, CHAIN);
        assertEq(pid, id);
        assertEq(seq, 1);
        assertEq(shares, 10 ether);
        assertEq(horizon, 3);
    }

    // ---- per-Position linear yield (docs/yield-model.md) ----

    function test_yieldIsLinearOnOwnPrincipal() public {
        uint64 a = _open(6 ether);
        vm.warp(block.timestamp + 5 minutes);
        uint64 b = _open(4 ether); // opens later, earns from its own open time
        vm.warp(block.timestamp + 10 minutes);
        // 5% APY, speedup 4380: yield = P * 500 * 4380 * dt / (10_000 * 365 days), 80% of it after the Yield Fee
        uint256 ya = (uint256(6 ether) * 500 * 4380 * 15 minutes) / (10_000 * 365 days) * 8 / 10;
        uint256 yb = (uint256(4 ether) * 500 * 4380 * 10 minutes) / (10_000 * 365 days) * 8 / 10;
        assertApproxEqAbs(vault.accruedYield(a), ya, 2);
        assertApproxEqAbs(vault.accruedYield(b), yb, 2);
        assertEq(lst.underlyingPerShare(), 1e18, "rate does not move");
    }

    function test_accrueMintsSharesIntoTheVaultAndKeepsReportsConsistent() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 view1 = vault.accruedYield(id);
        vault.accrue(id);
        assertEq(vault.accruedYield(id), view1);
        assertEq(lst.balanceOf(address(vault)), vault.getPosition(id).heldShares + vault.treasuryShares());
        assertGt(lst.balanceOf(address(vault)), 10 ether);
        assertEq(lst.totalSupply(), lst.faucetAmount() + lst.balanceOf(address(vault)) - 10 ether);
    }

    /// An Advance of N months (principal * apy * N / 12) is repaid at exactly N * 10 minutes (speedup 4,380)
    /// when no Yield Fee is taken.
    function test_advanceOfNMonthsIsRepaidInNTimesTenMinutes() public {
        vault.setYieldFeeBps(0);
        uint64 id = _open(10 ether);
        for (uint256 n = 1; n <= 12; n++) {
            uint256 advance = (10 ether * 500 * n) / (10_000 * 12);
            vm.warp(vault.getPosition(id).openTime + n * 10 minutes);
            assertGe(vault.accruedYield(id), advance, "repaid");
            vm.warp(vault.getPosition(id).openTime + n * 10 minutes - 1);
            assertLt(vault.accruedYield(id), advance, "not before");
        }
    }

    function test_noAccrualAfterUnlock() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        _deliver(_unlockMsg(id, 1));
        uint256 frozen = vault.accruedYield(id);
        uint256 supply = lst.totalSupply();
        vm.warp(block.timestamp + 1 days);
        vault.accrue(id);
        assertEq(vault.accruedYield(id), frozen);
        assertEq(lst.totalSupply(), supply);
    }

    function test_unlockedPrincipalAndYieldStayCovered() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        _deliver(_unlockMsg(id, 1));
        uint256 owed = vault.payableYield(id);
        assertGt(owed, 0);
        _deliver(_payMsg(id, 2, redeemer, owed));
        assertApproxEqAbs(lst.balanceOf(redeemer), owed, 2);
        assertGe(lst.balanceOf(alice), 10 ether - 1);
    }

    // ---- Yield Fee and Treasury ----

    function test_yieldFeeSplitsEachMintBetweenPositionAndTreasury() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 gross = (uint256(10 ether) * 500 * 4380 * 10 minutes) / (10_000 * 365 days);
        vault.accrue(id);
        assertApproxEqAbs(vault.accruedYield(id), gross * 8 / 10, 2);
        assertApproxEqAbs(vault.treasuryShares(), gross * 2 / 10, 2);
        assertEq(vault.treasuryIn(), vault.treasuryShares());
        assertEq(vault.treasuryBalance(), vault.treasuryShares());
        assertEq(lst.balanceOf(address(vault)), vault.getPosition(id).heldShares + vault.treasuryShares());
    }

    function test_yieldFeeViewMatchesAccrueExactly() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 7 minutes + 13);
        uint256 viewed = vault.accruedYield(id);
        vault.accrue(id);
        assertEq(vault.accruedYield(id), viewed);
    }

    function test_zeroFeeKeepsTheWholeYieldWithThePosition() public {
        vault.setYieldFeeBps(0);
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 gross = (uint256(10 ether) * 500 * 4380 * 10 minutes) / (10_000 * 365 days);
        vault.accrue(id);
        assertApproxEqAbs(vault.accruedYield(id), gross, 2);
        assertEq(vault.treasuryShares(), 0);
        assertEq(vault.treasuryIn(), 0);
    }

    function test_setYieldFeeIsAdminOnlyAndCapped() public {
        vm.prank(alice);
        vm.expectRevert(PositionVault.NotAdmin.selector);
        vault.setYieldFeeBps(100);
        vm.expectRevert(PositionVault.FeeTooHigh.selector);
        vault.setYieldFeeBps(5001);
        vault.setYieldFeeBps(5000);
        assertEq(vault.yieldFeeBps(), 5000);
    }

    function test_fundTreasuryIsAdminOnlyAndRaisesTreasuryIn() public {
        lst.faucet(address(this));
        lst.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(PositionVault.NotAdmin.selector);
        vault.fundTreasury(1 ether);
        vault.fundTreasury(1 ether);
        assertEq(vault.treasuryShares(), 1 ether);
        assertEq(vault.treasuryIn(), 1 ether);
        assertEq(lst.balanceOf(address(vault)), 1 ether);
    }

    function _fundTreasury(uint256 shares) internal {
        lst.faucet(address(this));
        lst.approve(address(vault), type(uint256).max);
        vault.fundTreasury(shares);
    }

    function _instantMsg(uint64 id, uint64 seq, address to, uint256 amt) internal pure returns (bytes memory) {
        return abi.encode(uint8(5), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt);
    }

    function test_payInstantPaysFromTreasuryAndLeavesThePositionAlone() public {
        uint64 id = _open(10 ether);
        _fundTreasury(1 ether);
        PositionVault.Position memory before = vault.getPosition(id);
        _deliver(_instantMsg(id, 1, redeemer, 0.4 ether));
        assertEq(lst.balanceOf(redeemer), 0.4 ether);
        assertEq(vault.treasuryShares(), 0.6 ether);
        assertEq(vault.instantPaid(), 0.4 ether);
        assertEq(vault.treasuryIn(), 1 ether, "treasuryIn never decreases");
        PositionVault.Position memory after_ = vault.getPosition(id);
        assertEq(after_.heldShares, before.heldShares);
        assertEq(after_.paidUnderlying, before.paidUnderlying);

        _deliver(_unlockMsg(id, 2));
        _deliver(_instantMsg(id, 3, redeemer, 0.1 ether)); // also works after Unlock
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
    }

    function test_payInstantRevertsWhenShortThenSucceedsOnceFundedAndReplayPaysOnce() public {
        uint64 id = _open(10 ether);
        _fundTreasury(0.3 ether);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, 0.5 ether, 0.3 ether));
        _deliver(_instantMsg(id, 1, redeemer, 0.5 ether));
        assertEq(lst.balanceOf(redeemer), 0);

        vault.fundTreasury(0.4 ether);
        _deliver(_instantMsg(id, 1, redeemer, 0.5 ether));
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
        _deliver(_instantMsg(id, 1, redeemer, 0.5 ether)); // replay
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
        assertEq(vault.instantPaid(), 0.5 ether);
    }

    function test_payYieldToTheVaultRefillsTheTreasury() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        vault.accrue(id);
        uint256 amt = vault.payableYield(id) / 2;
        uint256 inBefore = vault.treasuryIn();
        uint256 sharesBefore = vault.treasuryShares();
        uint256 heldBefore = vault.getPosition(id).heldShares;
        _deliver(_payMsg(id, 1, address(vault), amt));
        assertEq(vault.treasuryShares(), sharesBefore + amt);
        assertEq(vault.treasuryIn(), inBefore + amt);
        assertEq(vault.getPosition(id).heldShares, heldBefore - amt);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
        assertEq(lst.balanceOf(address(vault)), vault.getPosition(id).heldShares + vault.treasuryShares());
    }

    function test_unlockNeverReleasesTreasuryShares() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        _fundTreasury(1 ether);
        vault.accrue(id);
        uint256 treasury = vault.treasuryShares();
        uint256 before = lst.balanceOf(alice);
        _deliver(_unlockMsg(id, 1));
        assertEq(lst.balanceOf(alice) - before, 10 ether, "exactly the Principal");
        assertEq(vault.treasuryShares(), treasury);
        assertGe(lst.balanceOf(address(vault)), treasury);
    }

    function test_vaultIsTheOnlyMinter() public {
        vm.expectRevert(SimLST.NotMinter.selector);
        lst.mint(address(this), 1);
    }

    function test_horizonBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(PositionVault.BadHorizon.selector);
        vault.openPosition(1 ether, 0);
        vm.expectRevert(PositionVault.BadHorizon.selector);
        vault.openPosition(1 ether, 13);
        vm.stopPrank();
    }

    function test_reportYieldMonotonicSeqAndCumulative() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        vault.reportYield(id);
        vm.warp(block.timestamp + 10 minutes);
        vault.reportYield(id);
        (,,, uint64 s1, uint256 a1,,,) =
            abi.decode(ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        (,,, uint64 s2, uint256 a2,,, uint256 t2) =
            abi.decode(ep.outboxPayload(2), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        assertEq(t2, vault.treasuryIn());
        assertEq(s1, 2);
        assertEq(s2, 3);
        assertGt(a1, 0);
        assertGt(a2, a1);
        assertEq(a2, vault.accruedYield(id));
    }

    function test_onlyEndpointCanDeliver() public {
        uint64 id = _open(1 ether);
        vm.expectRevert(PositionVault.NotEndpoint.selector);
        vault.receiveMessage(_unlockMsg(id, 1));
    }

    function test_unlockReleasesPrincipalToOwner() public {
        uint64 id = _open(10 ether);
        uint256 before = lst.balanceOf(alice);
        _deliver(_unlockMsg(id, 1));
        assertEq(lst.balanceOf(alice), before + 10 ether);
        assertEq(lst.balanceOf(address(vault)), 0);
        assertTrue(vault.getPosition(id).unlocked);
    }

    function test_unlockAfterYieldKeepsYieldForRedeemers() public {
        uint64 id = _open(10 ether);
        uint256 before = lst.balanceOf(alice);
        vm.warp(block.timestamp + 20 minutes);
        uint256 accrued = vault.accruedYield(id);
        assertGt(accrued, 0);
        _deliver(_unlockMsg(id, 1));
        // owner got Principal (in underlying) back, no more
        uint256 back = lst.balanceOf(alice) - before;
        assertApproxEqAbs(back * lst.underlyingPerShare() / 1e18, vault.getPosition(id).principalUnderlying, 2);
        // yield is frozen and still payable after unlock
        vm.warp(block.timestamp + 20 minutes);
        assertEq(vault.accruedYield(id), accrued);
        _deliver(_payMsg(id, 2, redeemer, accrued));
        assertApproxEqAbs(lst.balanceOf(redeemer) * lst.underlyingPerShare() / 1e18, accrued, 1e10);
    }

    function test_unlockReplayAndOutOfOrderAreNoOps() public {
        uint64 id = _open(10 ether);
        _deliver(_unlockMsg(id, 5));
        uint256 aliceBal = lst.balanceOf(alice);
        uint256 vaultBal = lst.balanceOf(address(vault));
        _deliver(_unlockMsg(id, 5)); // replay
        _deliver(_unlockMsg(id, 3)); // older
        assertEq(lst.balanceOf(address(vault)), vaultBal);
        assertEq(lst.balanceOf(alice), aliceBal);
    }

    /// F-04. LayerZero V2 executes verified messages in any order (and a reverted one is retried later),
    /// but the vault used a strictly increasing seq as its idempotency guard, so a later message that
    /// lands first turned the earlier one into a silent no-op.
    function test_f04_unlockDeliveredAfterALaterPayYieldStillReleasesPrincipal() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_payMsg(id, 2, redeemer, accrued / 2)); // sent after the Unlock, delivered first
        uint256 before = lst.balanceOf(alice);
        _deliver(_unlockMsg(id, 1));
        assertTrue(vault.getPosition(id).unlocked, "Unlock was dropped as stale");
        assertGt(lst.balanceOf(alice), before, "Principal was never released");
    }

    function test_f04_payYieldDeliveredAfterALaterMessageIsStillPaidOnce() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_payMsg(id, 3, redeemer, accrued / 4));
        _deliver(_payMsg(id, 2, redeemer, accrued / 4)); // older seq, arrives second
        assertEq(vault.getPosition(id).paidUnderlying, 2 * (accrued / 4), "older PayYield was dropped");
        uint256 bal = lst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, accrued / 4)); // replay
        _deliver(_payMsg(id, 3, redeemer, accrued / 4)); // replay
        assertEq(lst.balanceOf(redeemer), bal);
        assertEq(vault.getPosition(id).paidUnderlying, 2 * (accrued / 4));
    }

    function test_payYieldOnlyUpToAccrued() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 accrued = vault.accruedYield(id);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.ExceedsAccruedYield.selector, accrued + 1, accrued));
        _deliver(_payMsg(id, 1, redeemer, accrued + 1));
        // the failed attempt did not consume seq 1
        _deliver(_payMsg(id, 1, redeemer, accrued / 2));
        assertEq(vault.getPosition(id).paidUnderlying, accrued / 2);
    }

    /// F-13. A PayYield for more than the vault's current yield reverts, which also undoes the seq mark,
    /// so the same message is delivered later (LayerZero keeps a reverted message for retry) once the
    /// yield has caught up. Nothing is paid, and nothing is lost, in between.
    function test_f13_payYieldAboveAccruedIsRetriableOnceYieldGrows() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 amount = vault.accruedYield(id) + 1 ether;
        vm.expectRevert();
        _deliver(_payMsg(id, 1, redeemer, amount));
        assertEq(lst.balanceOf(redeemer), 0);
        vm.warp(block.timestamp + 20 days);
        assertGe(vault.payableYield(id), amount, "yield caught up");
        _deliver(_payMsg(id, 1, redeemer, amount));
        assertEq(vault.getPosition(id).paidUnderlying, amount);
        assertGt(lst.balanceOf(redeemer), 0);
        _deliver(_payMsg(id, 1, redeemer, amount)); // a second delivery pays nothing
        assertEq(vault.getPosition(id).paidUnderlying, amount);
    }

    function test_payYieldReplayPaysOnce() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 amt = vault.accruedYield(id) / 2;
        _deliver(_payMsg(id, 1, redeemer, amt));
        uint256 bal = lst.balanceOf(redeemer);
        _deliver(_payMsg(id, 1, redeemer, amt));
        assertEq(lst.balanceOf(redeemer), bal);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
    }

    function test_payYieldCumulativeCapAcrossMessages() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, accrued));
        vm.expectRevert();
        _deliver(_payMsg(id, 2, redeemer, 1e12));
    }

    function test_payYieldNeverTouchesPrincipal() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 30 minutes);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, accrued));
        PositionVault.Position memory p = vault.getPosition(id);
        assertGe(p.heldShares * lst.underlyingPerShare() / 1e18 + 1, p.principalUnderlying);
    }

    function test_wrongChainIgnored() public {
        uint64 id = _open(1 ether);
        _deliver(abi.encode(uint8(3), uint32(1), id, uint64(1)));
        assertFalse(vault.getPosition(id).unlocked);
    }

    function test_unknownPositionAndMessageRevert() public {
        vm.expectRevert(PositionVault.UnknownPosition.selector);
        _deliver(_unlockMsg(99, 1));
        uint64 id = _open(1 ether);
        vm.expectRevert(PositionVault.UnknownMessage.selector);
        _deliver(abi.encode(uint8(9), CHAIN, id, uint64(1)));
    }
}

contract PositionVaultWstETHTest is VaultBase {
    MockWstETH wst;
    WstETHRateAdapter adapter;

    function setUp() public {
        wst = new MockWstETH();
        adapter = new WstETHRateAdapter(address(wst));
        ep = new MockEndpoint();
        vault = new PositionVault(address(wst), address(adapter), address(ep), CHAIN, address(0));
        wst.mint(alice, 100 ether);
        vm.prank(alice);
        wst.approve(address(vault), type(uint256).max);
    }

    function test_adapterReadsStEthPerToken() public {
        assertEq(adapter.underlyingPerShare(), 1.03e18);
        wst.setRate(1.05e18);
        assertEq(adapter.underlyingPerShare(), 1.05e18);
    }

    function test_movingRateDrivesYield() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        assertEq(vault.accruedYield(id), 0);
        wst.setRate(1.0403e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.0824 ether, 3); // 10 * (1.0403 - 1.03) = 0.103, 80% after the Yield Fee
        wst.setRate(1.0506e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.1648 ether, 3);
    }

    function test_rateDropGivesZeroYieldNotUnderflow() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0e18);
        assertEq(vault.accruedYield(id), 0);
        vault.reportYield(id);
        _deliver(_unlockMsg(id, 1));
        assertEq(wst.balanceOf(alice), 100 ether);
    }

    function test_payYieldInSharesWorthUnderlying() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        _deliver(_payMsg(id, 1, redeemer, 0.05 ether)); // within the 0.0824 left after the fee
        uint256 worth = wst.balanceOf(redeemer) * 1.0403e18 / 1e18;
        assertGe(worth, 0.05 ether - 1);
        assertLe(worth, 0.05 ether + 2);
    }

    function _openAtParRate() internal returns (uint64 id) {
        wst.setRate(1e18);
        vm.prank(alice);
        id = vault.openPosition(10 ether, 12);
    }

    /// Paid shares are rounded down, so a claim is short by less than one share-wei of value.
    function _assertPaidInFull(uint256 before, uint256 rate, uint256 claim) internal view {
        uint256 worth = (wst.balanceOf(redeemer) - before) * rate / 1e18;
        assertGe(worth + rate / 1e18 + 1, claim, "claim paid in full");
    }

    /// SP-01. Shares paid out for a claim stop earning in the vault, so accrued yield counts only the shares
    /// still held, and a claim within it is paid in full.
    function test_sp01_yieldAfterAPayoutCountsOnlyHeldShares() public {
        vault.setYieldFeeBps(0); // exact share arithmetic; the fee has its own suite
        uint64 id = _openAtParRate();
        wst.setRate(1.1e18);
        _deliver(_payMsg(id, 1, redeemer, 0.5 ether));
        wst.setRate(1.2e18);
        // 0.5 paid + (10 - 0.5/1.1 - 10/1.2) shares at 1.2; counting the paid-out shares would give 2
        assertApproxEqAbs(vault.accruedYield(id), 1.954545454545454545 ether, 3);

        uint256 claim = vault.payableYield(id);
        uint256 before = wst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, claim));
        _assertPaidInFull(before, 1.2e18, claim);
        PositionVault.Position memory p = vault.getPosition(id);
        assertGe(p.heldShares * 1.2e18 / 1e18, p.principalUnderlying, "Principal intact");
    }

    /// SP-01. A claim the held shares cannot cover reverts (retryable) instead of paying less and recording
    /// the whole claim as paid.
    function test_sp01_claimAboveBackedYieldRevertsThenPaysInFull() public {
        uint64 id = _openAtParRate();
        wst.setRate(1.1e18);
        _deliver(_payMsg(id, 1, redeemer, 0.5 ether));
        wst.setRate(1.2e18);
        vm.expectPartialRevert(PositionVault.ExceedsAccruedYield.selector); // about 1.4545 is backed
        _deliver(_payMsg(id, 2, redeemer, 1.5 ether));
        assertEq(vault.getPosition(id).paidUnderlying, 0.5 ether);

        wst.setRate(1.4e18);
        uint256 before = wst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, 1.5 ether));
        _assertPaidInFull(before, 1.4e18, 1.5 ether);
        assertEq(vault.getPosition(id).paidUnderlying, 2 ether);
    }

    /// After Unlock, a fallen rate can leave too few shares for a claim; it reverts rather than underpays.
    function test_sp01_claimAfterUnlockWithFallenRateRevertsUntilRecovered() public {
        uint64 id = _openAtParRate();
        wst.setRate(1.2e18);
        _deliver(_unlockMsg(id, 1));
        uint256 claim = vault.payableYield(id);
        wst.setRate(1e18);
        vm.expectPartialRevert(PositionVault.InsufficientShares.selector);
        _deliver(_payMsg(id, 2, redeemer, claim));

        wst.setRate(1.2e18);
        uint256 before = wst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, claim));
        _assertPaidInFull(before, 1.2e18, claim);
    }

    function testFuzz_sp01_claimsWithinPayableArePaidInFull(uint256 r1, uint256 r2, uint256 f1, uint256 f2) public {
        uint64 id = _openAtParRate();
        r1 = bound(r1, 1e18, 2e18);
        r2 = bound(r2, r1, 3e18);
        wst.setRate(r1);
        uint256 a1 = vault.payableYield(id) * bound(f1, 0, 100) / 100;
        uint256 before = wst.balanceOf(redeemer);
        _deliver(_payMsg(id, 1, redeemer, a1));
        _assertPaidInFull(before, r1, a1);

        wst.setRate(r2);
        uint256 a2 = vault.payableYield(id) * bound(f2, 0, 100) / 100;
        before = wst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, a2));
        _assertPaidInFull(before, r2, a2);
        PositionVault.Position memory p = vault.getPosition(id);
        assertGe(p.heldShares * r2 / 1e18 + 1, p.principalUnderlying);
        assertEq(p.paidUnderlying, a1 + a2);
    }

    /// Paying a claim never lowers the cumulative the vault reports: tesoro_core rejects a decrease.
    function testFuzz_sp01_reportedYieldNeverDropsAfterAPayout(uint256 r, uint256 f) public {
        uint64 id = _openAtParRate();
        wst.setRate(bound(r, 1e18, 3e18));
        uint256 before = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, vault.payableYield(id) * bound(f, 0, 100) / 100));
        assertGe(vault.accruedYield(id), before);
    }

    /// PR-01. tesoro_core stores Principal as u64; a larger Position could never open on Solana and its
    /// Principal could never unlock, so the vault refuses it.
    function test_pr01_principalAboveU64IsRefused() public {
        vm.prank(alice);
        vm.expectRevert(PositionVault.PrincipalTooLarge.selector);
        vault.openPosition(20 ether, 6); // 20.6e18 underlying at 1.03 > u64 max (~18.45e18)
        vm.prank(alice);
        uint64 id = vault.openPosition(17 ether, 6);
        assertLe(vault.getPosition(id).principalUnderlying, type(uint64).max);
    }
}

/// Real rate source (no minter): yield is rate growth on the Position's shares, the Yield Fee is taken at the source.
contract PositionVaultRateFeeTest is VaultBase {
    MockWstETH wst;

    function setUp() public {
        wst = new MockWstETH();
        wst.setRate(1e18);
        ep = new MockEndpoint();
        vault = new PositionVault(
            address(wst), address(new WstETHRateAdapter(address(wst))), address(ep), CHAIN, address(0)
        );
        wst.mint(alice, 100 ether);
        vm.prank(alice);
        wst.approve(address(vault), type(uint256).max);
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition(amt, 12);
    }

    function test_rateGrowthYieldGoesTwentyPercentToTreasuryAtTheSource() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18); // Principal 10 -> worth 10.5; gross yield 0.5
        uint256 viewed = vault.accruedYield(id);
        assertApproxEqAbs(viewed, 0.4 ether, 2, "Position keeps 80%");
        vault.reportYield(id);
        assertEq(vault.accruedYield(id), viewed, "view matches accrue");
        assertApproxEqAbs(vault.treasuryIn(), 0.1 ether, 2, "Treasury gets 20% of 0.5");
        assertApproxEqAbs(vault.treasuryBalance(), 0.1 ether, 2);
        assertEq(wst.balanceOf(address(vault)), vault.getPosition(id).heldShares + vault.treasuryShares());
        vault.reportYield(id);
        assertApproxEqAbs(vault.treasuryIn(), 0.1 ether, 2, "no double charge");
    }

    function test_feeIsChargedOnlyOnNewGrowthAcrossAccruals() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.02e18);
        vault.accrue(id);
        wst.setRate(1.05e18);
        vault.accrue(id);
        // Fee shares leave the Position at the first rate, so only the Position's remaining shares earn the rest.
        assertApproxEqRel(vault.treasuryIn(), 0.1 ether, 0.01e18);
        assertApproxEqRel(vault.accruedYield(id), 0.4 ether, 0.01e18);
    }

    function test_rateFallThenRecoveryChargesNothingUntilNewHighs() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18);
        vault.accrue(id);
        uint256 inBefore = vault.treasuryIn();
        wst.setRate(1.03e18);
        vault.accrue(id);
        wst.setRate(1.05e18);
        vault.accrue(id);
        assertApproxEqAbs(vault.treasuryIn(), inBefore, 4, "no fee for regained ground");
    }

    function test_paidYieldDoesNotRestartTheFee() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18);
        _deliver(_payMsg(id, 1, redeemer, 0.2 ether));
        uint256 inAfterPay = vault.treasuryIn();
        assertApproxEqAbs(inAfterPay, 0.1 ether, 2);
        vault.accrue(id);
        assertEq(vault.treasuryIn(), inAfterPay);
        assertApproxEqAbs(vault.accruedYield(id), 0.4 ether, 3);
    }

    function test_unlockChargesTheFeeThenFreezes() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18);
        _deliver(_unlockMsg(id, 1));
        assertApproxEqAbs(vault.treasuryIn(), 0.1 ether, 2);
        assertApproxEqAbs(vault.accruedYield(id), 0.4 ether, 3);
        wst.setRate(1.2e18);
        vault.reportYield(id);
        assertApproxEqAbs(vault.treasuryIn(), 0.1 ether, 2, "frozen after Unlock");
    }

    function test_zeroFeeTakesNothing() public {
        vault.setYieldFeeBps(0);
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18);
        vault.accrue(id);
        assertEq(vault.treasuryIn(), 0);
        assertApproxEqAbs(vault.accruedYield(id), 0.5 ether, 2);
    }

    function test_reportIs77BytesOnTheWireWithTreasuryIn() public {
        uint64 id = _open(10 ether);
        wst.setRate(1.05e18);
        vault.reportYield(id);
        (uint8 t,,,, uint256 accrued,,, uint256 tIn) = abi.decode(
            ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256)
        );
        assertEq(t, 2);
        assertEq(accrued, vault.accruedYield(id));
        assertEq(tIn, vault.treasuryIn());
    }

    function testFuzz_feeBooksStayBacked(uint256 r1, uint256 r2, uint256 pay) public {
        uint64 id = _open(10 ether);
        r1 = bound(r1, 0.9e18, 1.5e18);
        r2 = bound(r2, 0.9e18, 1.5e18);
        wst.setRate(r1);
        vault.accrue(id);
        wst.setRate(r2);
        vault.accrue(id);
        pay = bound(pay, 0, vault.payableYield(id));
        if (pay > 0) _deliver(_payMsg(id, 1, redeemer, pay));
        assertEq(wst.balanceOf(address(vault)), vault.getPosition(id).heldShares + vault.treasuryShares());
        assertLe(vault.getPosition(id).paidUnderlying, vault.accruedYield(id));
    }
}
