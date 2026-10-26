// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultBase} from "../src/PositionVaultBase.sol";
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
        return _payFeeMsg(id, seq, to, amt, 0, 0);
    }

    function _payFeeMsg(uint64 id, uint64 seq, address to, uint256 amt, uint256 fee, uint256 pool)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(uint8(4), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt, fee, pool);
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
        // 5% APY, speedup 4380: yield = P * 500 * 4380 * dt / (10_000 * 365 days), all of it Gemas (no fee yet)
        uint256 ya = (uint256(6 ether) * 500 * 4380 * 15 minutes) / (10_000 * 365 days);
        uint256 yb = (uint256(4 ether) * 500 * 4380 * 10 minutes) / (10_000 * 365 days);
        assertApproxEqAbs(vault.accruedYield(a), ya, 2);
        assertApproxEqAbs(vault.accruedYield(b), yb, 2);
        assertEq(lst.underlyingPerShare(), 1e18, "rate does not move");
    }

    /// An Advance of N months (principal * apy * N / 12) is repaid at exactly N * 10 minutes (speedup 4,380):
    /// the vault reports gross yield, so the Yield Fee never stretches the Debt.
    function test_advanceOfNMonthsIsRepaidInNTimesTenMinutes() public {
        uint64 id = _open(10 ether);
        for (uint256 n = 1; n <= 12; n++) {
            uint256 advance = (10 ether * 500 * n) / (10_000 * 12);
            vm.warp(vault.getPosition(id).openTime + n * 10 minutes);
            assertGe(vault.accruedYield(id), advance, "repaid");
            vm.warp(vault.getPosition(id).openTime + n * 10 minutes - 1);
            assertLt(vault.accruedYield(id), advance, "not before");
        }
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

    // ---- no crank: Accrued Yield by formula (ADR 0010) ----

    function _gross(uint256 principal, uint256 dt) internal pure returns (uint256) {
        return (principal * 500 * 4380 * dt) / (10_000 * 365 days);
    }

    function test_nothingIsMintedUntilAPayoutNeedsIt() public {
        uint64 id = _open(10 ether);
        uint256 supply = lst.totalSupply();
        vm.warp(block.timestamp + 10 minutes);
        vault.reportYield(id);
        assertGt(vault.accruedYield(id), 0);
        assertEq(lst.totalSupply(), supply, "reporting mints nothing");
        assertEq(lst.balanceOf(address(vault)), 10 ether);
        uint256 owed = vault.payableYield(id);
        _deliver(_payMsg(id, 1, redeemer, owed));
        assertEq(lst.balanceOf(redeemer), owed);
        assertEq(lst.totalSupply(), supply + owed, "minted exactly what was paid");
        assertEq(lst.balanceOf(address(vault)), 10 ether, "Principal untouched");
    }

    function test_accruedYieldIsTheFormulaAtEveryTime() public {
        uint64 id = _open(10 ether);
        uint256 t0 = block.timestamp;
        assertEq(vault.accruedYield(id), 0, "zero at open");
        uint256[4] memory dts = [uint256(1), 5 minutes, 10 minutes, 40 days];
        for (uint256 i; i < dts.length; i++) {
            vm.warp(t0 + dts[i]);
            uint256 g = _gross(10 ether, dts[i]);
            assertEq(vault.accruedYield(id), g, "gross, no fee");
        }
    }

    function test_apyIsFixedAtOpenPerPosition() public {
        uint64 a = _open(4 ether);
        lst.setRateParams(1000, 4380); // 10% APY from now on
        uint64 b = _open(4 ether);
        vm.warp(block.timestamp + 10 minutes);
        assertEq(vault.getPosition(a).apyBps, 500);
        assertEq(vault.getPosition(b).apyBps, 1000);
        assertApproxEqAbs(vault.accruedYield(b), vault.accruedYield(a) * 2, 2);
        assertEq(vault.treasuryBalance(), 0, "yield of open Positions is never the Treasury's");
    }

    function test_treasuryStaysEmptyWhileYieldIsOpenAndAtUnlock() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        assertEq(vault.treasuryBalance(), 0);
        _deliver(_unlockMsg(id, 1));
        assertEq(vault.treasuryBalance(), 0, "Unlock realises no fee");
        assertEq(vault.realisedFees(), 0);
        assertEq(vault.poolOwedUnits(), 0, "Unlock owes the Pool nothing");
        assertEq(vault.accruedYield(id), _gross(10 ether, 10 minutes), "frozen at the gross yield");
    }

    function test_holderPayYieldWithFeePaysNetAndGrowsTreasuryAndPool() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        uint256 fee = amount / 5;
        uint256 pool = fee / 2;
        uint256 supply = lst.totalSupply();
        _deliver(_payFeeMsg(id, 1, redeemer, amount, fee, pool));
        assertEq(lst.balanceOf(redeemer), amount - fee, "holder gets amount minus fee");
        assertEq(vault.getPosition(id).paidUnderlying, amount, "the Position is debited the gross");
        assertEq(vault.realisedFees(), fee);
        assertEq(vault.poolOwedUnits(), pool);
        assertEq(vault.treasuryBalance(), fee - pool, "Treasury keeps the fee minus the Pool's part");
        assertEq(lst.totalSupply(), supply + amount - fee, "the fee is not minted until it is spent");
    }

    function test_exemptPayYieldPaysTheFullAmount() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        _deliver(_payFeeMsg(id, 1, redeemer, amount, 0, 0));
        assertEq(lst.balanceOf(redeemer), amount);
        assertEq(vault.realisedFees(), 0);
        assertEq(vault.treasuryBalance(), 0);
    }

    function test_refillPayYieldKeepsEverythingAndOwesThePool() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        uint256 pool = amount / 4;
        uint256 supply = lst.totalSupply();
        _deliver(_payFeeMsg(id, 1, address(vault), amount, amount / 5, pool));
        assertEq(lst.totalSupply(), supply, "a refill moves nothing");
        assertEq(vault.treasuryCredited(), amount);
        assertEq(vault.poolOwedUnits(), pool);
        assertEq(vault.treasuryBalance(), amount - pool);
    }

    function test_payYieldRefusesAFeeOrPoolAboveTheAmount() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.BadFeeSplit.selector, 100, 101, 0));
        _deliver(_payFeeMsg(id, 1, redeemer, 100, 101, 0));
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.BadFeeSplit.selector, 100, 10, 101));
        _deliver(_payFeeMsg(id, 1, redeemer, 100, 10, 101));
    }

    /// Defence in depth (red-team 31 #10): a bridge bug can never take more than the 50% Yield Fee cap of a holder's
    /// yield; the cap itself still passes.
    function test_payYieldRefusesAFeeAboveTheYieldFeeCap() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.BadFeeSplit.selector, 100, 51, 0));
        _deliver(_payFeeMsg(id, 1, redeemer, 100, 51, 0));
        uint256 before = lst.balanceOf(redeemer);
        _deliver(_payFeeMsg(id, 1, redeemer, 100, 50, 25));
        assertEq(lst.balanceOf(redeemer) - before, 50);
    }

    function test_noAccrualAfterUnlock() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        _deliver(_unlockMsg(id, 1));
        uint256 frozen = vault.accruedYield(id);
        uint256 claim = vault.treasuryBalance();
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.accruedYield(id), frozen);
        assertEq(vault.treasuryBalance(), claim, "a closed Position's fee stops growing");
    }

    // ---- Treasury: funding, withdrawal, Instant Redeem, refund ----

    function test_fundTreasuryIsAdminOnly() public {
        lst.faucet(address(this));
        lst.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(PositionVaultBase.NotAdmin.selector);
        vault.fundTreasury(1 ether);
        vault.fundTreasury(1 ether);
        assertEq(vault.treasuryBalance(), 1 ether);
        assertEq(lst.balanceOf(address(vault)), 1 ether);
    }

    function _fundTreasury(uint256 shares) internal {
        if (lst.balanceOf(address(this)) < shares) lst.faucet(address(this));
        lst.approve(address(vault), type(uint256).max);
        vault.fundTreasury(shares);
    }

    function _instantMsg(uint64 id, uint64 seq, address to, uint256 amt) internal pure returns (bytes memory) {
        return abi.encode(uint8(5), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt);
    }

    function test_withdrawTreasuryTakesFeesAndFundingAndNothingMore() public {
        uint64 id = _open(10 ether);
        _fundTreasury(1 ether);
        uint256 supply0 = lst.totalSupply();
        vm.warp(block.timestamp + 10 minutes);
        uint256 fee = _gross(10 ether, 10 minutes) / 5;
        _deliver(_payFeeMsg(id, 1, redeemer, fee * 5 / 2, fee / 2, fee / 4)); // a cash-out takes a fee
        uint256 treasury = vault.treasuryBalance();
        assertEq(treasury, 1 ether + fee / 2 - fee / 4);

        vm.prank(alice);
        vm.expectRevert(PositionVaultBase.NotAdmin.selector);
        vault.withdrawTreasury(1, alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, treasury + 1e18, treasury));
        vault.withdrawTreasury(treasury + 1e18, address(0xC0FFEE));

        // more than the funding: the excess is a fee that was never minted, so it is minted now
        uint256 take = treasury - 1;
        vault.withdrawTreasury(take, address(0xC0FFEE));
        assertEq(lst.balanceOf(address(0xC0FFEE)), take);
        // the cash-out holder (net of the fee) and the withdrawal are paid from the funded shares first
        assertEq(
            lst.totalSupply(),
            supply0 + (fee * 5 / 2 - fee / 2) + take - 1 ether,
            "funded shares are paid before anything is minted"
        );
        assertApproxEqAbs(vault.treasuryBalance(), 1, 3);
        assertEq(lst.balanceOf(address(vault)), 10 ether, "Principal untouched");
        _deliver(_unlockMsg(id, 2));
        assertEq(lst.balanceOf(alice), lst.faucetAmount(), "Principal back in full");
    }

    function test_payInstantPaysFromTheTreasuryAndLeavesThePositionAlone() public {
        uint64 id = _open(10 ether);
        _fundTreasury(1 ether);
        PositionVaultBase.Position memory before = vault.getPosition(id);
        _deliver(_instantMsg(id, 1, redeemer, 0.4 ether));
        assertEq(lst.balanceOf(redeemer), 0.4 ether);
        assertEq(vault.treasuryBalance(), 0.6 ether);
        assertEq(vault.instantPaid(), 0.4 ether);
        PositionVaultBase.Position memory after_ = vault.getPosition(id);
        assertEq(after_.paidUnderlying, before.paidUnderlying);

        _deliver(_unlockMsg(id, 2));
        _deliver(_instantMsg(id, 3, redeemer, 0.1 ether)); // also works after Unlock
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
    }

    function test_payInstantFromUnmintedFeesMintsAtPayout() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        _deliver(_payFeeMsg(id, 1, address(0xDEAD), amount, amount / 5, 0));
        uint256 fee = vault.treasuryBalance();
        assertEq(fee, amount / 5);
        assertEq(lst.balanceOf(address(vault)), 10 ether);
        _deliver(_instantMsg(id, 2, redeemer, fee / 2));
        assertEq(lst.balanceOf(redeemer), fee / 2);
        assertEq(lst.balanceOf(address(vault)), 10 ether);
    }

    function test_payInstantShortRevertsAndTheSameMessagePaysOnceFunded() public {
        uint64 id = _open(10 ether);
        _fundTreasury(0.3 ether);
        uint256 outbox = ep.outboxLength();
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 0.5 ether, 0.3 ether));
        _deliver(_instantMsg(id, 7, redeemer, 0.5 ether));
        assertEq(lst.balanceOf(redeemer), 0);
        assertEq(vault.instantPaid(), 0);
        assertEq(vault.treasuryBalance(), 0.3 ether);
        assertEq(ep.outboxLength(), outbox, "no refund message exists");

        // Funded since: the same message, delivered again, pays once.
        _fundTreasury(0.4 ether);
        _deliver(_instantMsg(id, 7, redeemer, 0.5 ether));
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
        assertEq(vault.instantPaid(), 0.5 ether);
        _deliver(_instantMsg(id, 7, redeemer, 0.5 ether)); // replay
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
    }

    function test_payYieldToTheVaultRefillsTheTreasury() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 amt = vault.payableYield(id) / 2;
        _fundTreasury(1 ether);
        uint256 fees = vault.treasuryBalance();
        uint256 supply = lst.totalSupply();
        _deliver(_payMsg(id, 1, address(vault), amt));
        assertEq(vault.treasuryBalance(), fees + amt);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
        assertEq(lst.totalSupply(), supply, "a refill moves nothing");
        _deliver(_instantMsg(id, 2, redeemer, amt));
        assertEq(lst.balanceOf(redeemer), amt);
    }

    function test_unlockNeverReleasesMoreThanThePrincipal() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        _fundTreasury(1 ether);
        uint256 before = lst.balanceOf(alice);
        _deliver(_unlockMsg(id, 1));
        assertEq(lst.balanceOf(alice) - before, 10 ether, "exactly the Principal");
        assertGe(lst.balanceOf(address(vault)), 1 ether);
    }

    function test_reportYieldOnDemandCarriesAccruedAndTreasuryBalance() public {
        uint64 id = _open(10 ether);
        _fundTreasury(1 ether);
        vm.warp(block.timestamp + 10 minutes);
        vault.reportYield(id);
        vm.warp(block.timestamp + 10 minutes);
        vault.reportYield(id);
        (,,, uint64 s1, uint256 a1,,, uint256 t1) =
            abi.decode(ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        (,,, uint64 s2, uint256 a2,,, uint256 t2) =
            abi.decode(ep.outboxPayload(2), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        assertEq(s1, 2);
        assertEq(s2, 3);
        assertGt(a1, 0);
        assertGt(a2, a1);
        assertEq(a2, vault.accruedYield(id));
        assertEq(a2, _gross(10 ether, 20 minutes), "the report carries the gross yield");
        assertEq(t2, vault.treasuryBalance());
        assertEq(t2, t1, "open yield adds nothing to the Treasury");
        // spending the Treasury lowers the next report
        _deliver(_instantMsg(id, 1, redeemer, t2 / 2));
        vault.reportYield(id);
        (,,,,,,, uint256 t3) =
            abi.decode(ep.outboxPayload(3), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        assertLt(t3, t2);
    }

    function test_payYieldNeverTouchesPrincipal() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 30 minutes);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, accrued));
        assertEq(lst.balanceOf(address(vault)), 10 ether);
    }

    function testFuzz_treasuryStaysEmptyForRandomOpensAndUnlocks(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 12));
        uint64[] memory ids = new uint64[](n);
        for (uint256 i; i < n; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (seed % 3 hours));
            lst.faucet(address(uint160(0x1000 + i)));
            vm.startPrank(address(uint160(0x1000 + i)));
            lst.approve(address(vault), type(uint256).max);
            ids[i] = vault.openPosition(1e6 + (seed >> 8) % 9 ether, 3);
            vm.stopPrank();
        }
        vm.warp(block.timestamp + (seed % 2 days));
        if (n > 2) _deliver(_unlockMsg(ids[1], 1));
        vm.warp(block.timestamp + 1 hours);
        assertEq(vault.treasuryBalance(), 0);
        assertEq(vault.poolOwedUnits(), 0);
    }

    function test_vaultIsTheOnlyMinter() public {
        vm.expectRevert(SimLST.NotMinter.selector);
        lst.mint(address(this), 1);
    }

    function test_horizonBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(PositionVaultBase.BadHorizon.selector);
        vault.openPosition(1 ether, 0);
        vm.expectRevert(PositionVaultBase.BadHorizon.selector);
        vault.openPosition(1 ether, 13);
        vm.stopPrank();
    }

    function test_onlyEndpointCanDeliver() public {
        uint64 id = _open(1 ether);
        vm.expectRevert(PositionVaultBase.NotEndpoint.selector);
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
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.ExceedsAccruedYield.selector, accrued + 1, accrued));
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

    function test_wrongChainIgnored() public {
        uint64 id = _open(1 ether);
        _deliver(abi.encode(uint8(3), uint32(1), id, uint64(1)));
        assertFalse(vault.getPosition(id).unlocked);
    }

    function test_unknownPositionAndMessageRevert() public {
        vm.expectRevert(PositionVaultBase.UnknownPosition.selector);
        _deliver(_unlockMsg(99, 1));
        uint64 id = _open(1 ether);
        vm.expectRevert(PositionVaultBase.UnknownMessage.selector);
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

    function test_rateDropGivesZeroYieldNotUnderflow() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0e18);
        assertEq(vault.accruedYield(id), 0);
        vault.reportYield(id);
        _deliver(_unlockMsg(id, 1));
        assertEq(wst.balanceOf(alice), 100 ether);
    }

    // Yield at the moved rate is Principal * (rate now / rate at open - 1), all of it Gemas; the Yield Fee is taken
    // when yield leaves (PayYield names it), and nothing is minted.

    function test_movingRateDrivesYield() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        assertEq(vault.accruedYield(id), 0);
        wst.setRate(1.0403e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.103 ether, 2); // 10 * (1.0403 - 1.03)
        assertEq(vault.treasuryBalance(), 0, "open yield is not spendable");
        wst.setRate(1.0506e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.206 ether, 2);
        assertEq(vault.treasuryBalance(), 0);
        _deliver(_unlockMsg(id, 1));
        assertEq(vault.treasuryBalance(), 0, "Unlock takes no fee");
        assertEq(vault.poolOwedShares(), 0);
    }

    function test_payYieldInSharesWorthUnderlyingFromTheHeldShares() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        _deliver(_payMsg(id, 1, redeemer, 0.05 ether));
        uint256 worth = wst.balanceOf(redeemer) * 1.0403e18 / 1e18;
        assertGe(worth, 0.05 ether - 1);
        assertLe(worth, 0.05 ether + 2);
        assertEq(wst.balanceOf(address(vault)), 10 ether - wst.balanceOf(redeemer));
    }

    function test_yieldIsIndependentOfPayouts() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        uint256 before = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, vault.payableYield(id) / 2));
        assertEq(vault.accruedYield(id), before, "the formula, not the held shares");
    }

    function test_treasuryOfARealVaultPaysInstantFromHeldShares() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        _deliver(_payFeeMsg(id, 1, redeemer, 0.05 ether, 0.02 ether, 0)); // a cash-out takes a fee
        uint256 fee = vault.treasuryBalance();
        assertApproxEqAbs(fee, 0.02 ether, 2);
        uint256 holderGot = wst.balanceOf(redeemer);
        _deliver(abi.encode(uint8(5), CHAIN, id, uint64(2), bytes32(uint256(uint160(redeemer))), fee));
        assertEq(vault.instantPaid(), fee);
        assertApproxEqAbs((wst.balanceOf(redeemer) - holderGot) * 1.0403e18 / 1e18, fee, 2);
        // the next one finds an empty Treasury: it waits, never touching Principal
        vm.expectPartialRevert(PositionVaultBase.InsufficientTreasury.selector);
        _deliver(abi.encode(uint8(5), CHAIN, id, uint64(3), bytes32(uint256(uint160(redeemer))), 1 ether));
    }

    function test_withdrawTreasuryPaysFromHeldSharesAndNeverMintsOrEatsPrincipal() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        assertEq(vault.treasuryBalance(), 0, "open yield is not withdrawable");
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 1, 0));
        vault.withdrawTreasury(1, address(0xC0FFEE));
        _deliver(_payFeeMsg(id, 1, redeemer, 0.05 ether, 0.02 ether, 0)); // a cash-out takes a fee
        _deliver(_unlockMsg(id, 2));
        assertApproxEqAbs((wst.balanceOf(alice) - 90 ether) * 1.0403e18 / 1e18, 10.3 ether, 2);
        uint256 fee = vault.treasuryBalance();
        assertApproxEqAbs(fee, 0.02 ether, 2);
        vault.withdrawTreasury(fee, address(0xC0FFEE));
        assertApproxEqAbs(wst.balanceOf(address(0xC0FFEE)) * 1.0403e18 / 1e18, fee, 2);
        assertLe(vault.treasuryBalance(), 1, "at most a wei of rounding dust stays");
    }

    function test_unlockReleasesPrincipalAtTheCurrentRateAndFreezesTheYield() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        uint256 accrued = vault.accruedYield(id);
        _deliver(_unlockMsg(id, 1));
        assertApproxEqAbs((wst.balanceOf(alice) - 90 ether) * 1.0403e18 / 1e18, 10.3 ether, 2);
        wst.setRate(1.2e18);
        assertEq(vault.accruedYield(id), accrued, "frozen at Unlock");
        _deliver(_payMsg(id, 2, redeemer, accrued));
        // Holders of an unlocked Position are owed shares fixed at the Unlock rate (they carry the move, up or
        // down): worth `accrued` at 1.0403, more at 1.2.
        assertApproxEqAbs(wst.balanceOf(redeemer) * 1.0403e18 / 1e18, accrued, 4);
    }

    function test_payYieldBeyondTheSpendableSharesRevertsRetryable() public {
        vm.prank(alice);
        uint64 a = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        _deliver(_payMsg(a, 1, redeemer, vault.payableYield(a)));
        wst.setRate(1.0403e18 / 2 + 1e17); // a fallen rate: reserve shares for open Principal grow
        // the formula says no yield, so nothing is claimable and nothing is paid
        assertEq(vault.payableYield(a), 0);
        vm.expectPartialRevert(PositionVaultBase.ExceedsAccruedYield.selector);
        _deliver(_payMsg(a, 2, redeemer, 1));
    }

    /// Yield is counted from the shares the Position still holds, so shares paid out stop earning and the vault
    /// can always cover every claim: partial PayYield, the rate rises again, report, final claim, Treasury.
    function test_realRateNeverOvercountsPaidOutShares() public {
        wst.setRate(1e18);
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 12);
        wst.setRate(1.1e18);
        _deliver(_payMsg(id, 1, redeemer, vault.payableYield(id) / 2)); // 0.4
        assertEq(wst.balanceOf(address(vault)), 10 ether - wst.balanceOf(redeemer));
        wst.setRate(1.2e18);
        vault.reportYield(id);
        // yield = (10 - paid/1.1) * 1.2 + paid - 10, all of it reported
        uint256 held = 10 ether - wst.balanceOf(redeemer);
        uint256 gross = held * 1.2e18 / 1e18 + vault.getPosition(id).paidUnderlying - 10 ether;
        assertApproxEqAbs(vault.accruedYield(id), gross, 4);
        (,,, uint64 seq, uint256 accrued,,, uint256 treasury) =
            abi.decode(ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        assertEq(seq, 2);
        assertEq(accrued, vault.accruedYield(id));
        assertEq(treasury, vault.treasuryBalance());
        assertEq(treasury, 0, "the open Position's yield is not spendable");

        uint256 claim = vault.payableYield(id);
        _deliver(_payMsg(id, 2, redeemer, claim)); // no InsufficientShares
        uint256 paid = vault.getPosition(id).paidUnderlying;
        // paid + Treasury never exceeds the value above Principal that the shares represent
        uint256 above = wst.balanceOf(address(vault)) * 1.2e18 / 1e18 + paid - 10 ether;
        assertLe(paid, above + 4);
        assertApproxEqAbs(paid, above, 6, "all of it is accounted for");

        // Principal is intact for Unlock, and Unlock takes no fee
        _deliver(_unlockMsg(id, 3));
        assertApproxEqAbs((wst.balanceOf(alice) - 90 ether) * 1.2e18 / 1e18, 10 ether, 2);
        assertEq(vault.treasuryBalance(), 0);
    }

    /// With several Positions the Treasury holds exactly the fees cash-outs took, and the Pool's part of them.
    function test_realRateTreasuryFollowsFeesTakenAtCashOut() public {
        wst.setRate(1e18);
        vm.startPrank(alice);
        uint64 a = vault.openPosition(10 ether, 12);
        uint64 b = vault.openPosition(5 ether, 12);
        vm.stopPrank();
        wst.setRate(1.1e18);
        uint256 amtA = vault.payableYield(a) / 2;
        _deliver(_payFeeMsg(a, 1, redeemer, amtA, amtA / 5, amtA / 10));
        wst.setRate(1.3e18);
        uint256 amtB = vault.payableYield(b);
        _deliver(_payFeeMsg(b, 1, redeemer, amtB, amtB / 5, amtB / 10));
        // shares are fixed at each cash-out's rate (1.1 and 1.3); the Treasury figure values them at the live rate
        uint256 poolShares = (amtA / 10) * 1e18 / 1.1e18 + (amtB / 10) * 1e18 / 1.3e18;
        uint256 keptShares = (amtA / 5 - amtA / 10) * 1e18 / 1.1e18 + (amtB / 5 - amtB / 10) * 1e18 / 1.3e18;
        assertApproxEqAbs(vault.poolOwedShares(), poolShares, 4, "the Pool's part, in shares");
        assertApproxEqAbs(vault.treasuryBalance(), keptShares * 1.3e18 / 1e18, 8, "Treasury keeps the rest");

        _deliver(_unlockMsg(b, 2));
        _deliver(_unlockMsg(a, 2));
        assertApproxEqAbs(vault.treasuryBalance(), keptShares * 1.3e18 / 1e18, 8, "Unlock changes nothing");
        assertLe(
            vault.owedShares() + vault.poolOwedShares() + vault.escrowShares() + vault.reservedShares(),
            vault.treasuryShares()
        );
    }

    /// An unlocked Position pays a holder with a fee: owed shares fall by the whole debit, the Treasury keeps the fee.
    function test_realUnlockedHolderPayYieldWithFee() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        _deliver(_unlockMsg(id, 1));
        uint256 owedBefore = vault.owedShares();
        uint256 tBefore = vault.treasuryShares();
        uint256 amount = vault.accruedYield(id);
        uint256 fee = amount / 5;
        _deliver(_payFeeMsg(id, 2, redeemer, amount, fee, fee / 2));
        assertEq(vault.owedShares(), owedBefore - (amount * 1e18 / vault.unlockRate(id)), "owed falls by the gross");
        assertApproxEqAbs(wst.balanceOf(redeemer) * 1.0403e18 / 1e18, amount - fee, 4);
        assertApproxEqAbs(vault.treasuryBalance(), fee - fee / 2, 6);
        assertEq(tBefore - vault.treasuryShares(), wst.balanceOf(redeemer));
    }

    /// A refill (to == vault) on a real vault keeps all the shares in the Treasury and owes the Pool its part.
    function test_realRefillKeepsEverythingAndOwesThePool() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        uint256 amount = 0.05 ether;
        _deliver(_payFeeMsg(id, 1, address(vault), amount, 0.01 ether, 0.02 ether));
        assertApproxEqAbs(vault.treasuryBalance(), amount - 0.02 ether, 4);
        assertApproxEqAbs(vault.poolOwedShares() * 1.0403e18 / 1e18, 0.02 ether, 4);
        assertEq(wst.balanceOf(redeemer), 0);
    }

    function _realGross(uint64 id) internal view returns (uint256) {
        PositionVaultBase.Position memory p = vault.getPosition(id);
        uint256 r = adapter.underlyingPerShare();
        return p.heldShares * r / 1e18 + p.paidUnderlying - p.principalUnderlying;
    }

    /// A claim within payable is always paid in full: yield is never counted on shares already paid out.
    function testFuzz_claimsAreNeverUnderpaid(uint256 r1, uint256 r2, uint256 f1, uint256 f2) public {
        wst.setRate(1e18);
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 12);
        r1 = bound(r1, 1e18, 2e18);
        r2 = bound(r2, r1, 3e18);
        uint256[2] memory rates = [r1, r2];
        uint256[2] memory fr = [bound(f1, 0, 100), bound(f2, 0, 100)];
        for (uint64 i; i < 2; i++) {
            wst.setRate(rates[i]);
            uint256 claim = vault.payableYield(id) * fr[i] / 100;
            uint256 before = wst.balanceOf(redeemer);
            try ep.deliver(address(vault), _payMsg(id, i + 1, redeemer, claim)) {
                uint256 worth = (wst.balanceOf(redeemer) - before) * rates[i] / 1e18;
                assertGe(worth + rates[i] / 1e18 + 1, claim, "claim paid in full");
            } catch {
                fail("a correct claim must be payable");
            }
        }
    }

    /// Paying a claim never lowers the cumulative the vault reports: tesoro_core rejects a decrease.
    function testFuzz_reportedYieldNeverDropsAfterAPayout(uint256 r, uint256 f) public {
        wst.setRate(1e18);
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 12);
        wst.setRate(bound(r, 1e18, 3e18));
        uint256 before = vault.accruedYield(id);
        _deliver(_payMsg(id, 1, redeemer, vault.payableYield(id) * bound(f, 0, 100) / 100));
        assertGe(vault.accruedYield(id), before);
    }

    /// PR-01. The bridge gives tesoro_core 1e-9 units as u64: a Position below one unit would open as zero and never
    /// unlock, and one above 2^64 units could never open on Solana, so the vault refuses both. Past the old 18.4-token
    /// wei limit is fine.
    function test_pr01_principalOutsideTheCoreUnitRangeIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(PositionVaultBase.PrincipalBelowUnit.selector);
        vault.openPosition(100, 6); // 100 wei is below one core unit
        wst.mint(alice, 1_000 ether);
        vm.prank(alice);
        uint64 big = vault.openPosition(1_000 ether, 6); // 1,000 ETH, far past 2^64 wei
        assertGt(vault.getPosition(big).principalUnderlying, type(uint64).max);
        assertLe(vault.getPosition(big).principalUnderlying / 1e9, type(uint64).max);
    }
}
