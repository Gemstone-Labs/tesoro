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
            assertEq(vault.accruedYield(id), g - (g * 2000) / 10_000);
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
        // the Treasury claim matches both Positions' own fees
        assertApproxEqAbs(vault.treasuryBalance(), (_fee(a) + _fee(b)) / 2, 2);
    }

    function _fee(uint64 id) internal view returns (uint256) {
        PositionVault.Position memory p = vault.getPosition(id);
        uint256 gross = (p.a * block.timestamp - p.b) / (10_000 * 365 days);
        return (gross * p.feeBps) / 10_000;
    }

    function test_treasuryClaimEqualsSumOfPerPositionFees() public {
        uint64[] memory ids = new uint64[](5);
        for (uint256 i; i < 5; i++) {
            ids[i] = _open(i * 0.5 ether + 0.5 ether);
            vm.warp(block.timestamp + (i + 1) * 3 minutes + 17);
        }
        uint256 sum;
        for (uint256 i; i < 5; i++) {
            sum += _fee(ids[i]);
        }
        assertApproxEqAbs(vault.treasuryBalance(), sum / 2, 5);
        // closing a Position moves its fee from the open sums to the realised total without changing the claim
        uint256 before = vault.treasuryBalance();
        _deliver(_unlockMsg(ids[1], 1));
        assertApproxEqAbs(vault.treasuryBalance(), before, 2);
        vm.warp(block.timestamp + 1 hours);
        sum = 0;
        for (uint256 i; i < 5; i++) {
            PositionVault.Position memory p = vault.getPosition(ids[i]);
            uint256 g = p.unlocked ? 0 : (p.a * block.timestamp - p.b) / (10_000 * 365 days);
            sum += p.unlocked ? (vault.accruedYield(ids[i]) * 2000) / 8000 : (g * 2000) / 10_000;
        }
        assertApproxEqAbs(vault.treasuryBalance(), sum / 2, 10);
    }

    function test_feeIsFlooredPerPosition() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 7 minutes + 13);
        uint256 g = _gross(10 ether, 7 minutes + 13);
        assertEq(vault.accruedYield(id), g - (g * 2000) / 10_000);
    }

    function test_zeroFeeKeepsTheWholeYieldWithThePosition() public {
        vault.setYieldFeeBps(0);
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 10 minutes);
        assertEq(vault.accruedYield(id), _gross(10 ether, 10 minutes));
        assertEq(vault.treasuryBalance(), 0);
    }

    function test_feeChangeOnlyAffectsNewPositions() public {
        uint64 a = _open(4 ether);
        vault.setYieldFeeBps(5000);
        uint64 b = _open(4 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 g = _gross(4 ether, 10 minutes);
        assertEq(vault.accruedYield(a), g - (g * 2000) / 10_000);
        assertEq(vault.accruedYield(b), g - g / 2);
        assertApproxEqAbs(vault.treasuryBalance(), ((g * 2000) / 10_000 + g / 2) / 2, 2);
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
        vm.expectRevert(PositionVault.NotAdmin.selector);
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
        vm.warp(block.timestamp + 10 minutes);
        uint256 treasury = vault.treasuryBalance();
        assertApproxEqAbs(treasury, 1 ether + (_gross(10 ether, 10 minutes) * 2000) / 10_000 / 2, 2);

        vm.prank(alice);
        vm.expectRevert(PositionVault.NotAdmin.selector);
        vault.withdrawTreasury(1, alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, treasury + 1e18, treasury));
        vault.withdrawTreasury(treasury + 1e18, address(0xC0FFEE));

        // more than the funding: the excess is a fee that was never minted, so it is minted now
        uint256 supply = lst.totalSupply();
        uint256 take = treasury - 1;
        vault.withdrawTreasury(take, address(0xC0FFEE));
        assertEq(lst.balanceOf(address(0xC0FFEE)), take);
        assertEq(lst.totalSupply(), supply + take - 1 ether, "funded shares are paid before anything is minted");
        assertApproxEqAbs(vault.treasuryBalance(), 1, 3);
        assertEq(lst.balanceOf(address(vault)), 10 ether, "Principal untouched");
        _deliver(_unlockMsg(id, 1));
        assertEq(lst.balanceOf(alice), lst.faucetAmount(), "Principal back in full");
    }

    function test_payInstantPaysFromTheTreasuryAndLeavesThePositionAlone() public {
        uint64 id = _open(10 ether);
        _fundTreasury(1 ether);
        PositionVault.Position memory before = vault.getPosition(id);
        _deliver(_instantMsg(id, 1, redeemer, 0.4 ether));
        assertEq(lst.balanceOf(redeemer), 0.4 ether);
        assertEq(vault.treasuryBalance(), 0.6 ether);
        assertEq(vault.instantPaid(), 0.4 ether);
        PositionVault.Position memory after_ = vault.getPosition(id);
        assertEq(after_.paidUnderlying, before.paidUnderlying);

        _deliver(_unlockMsg(id, 2));
        _deliver(_instantMsg(id, 3, redeemer, 0.1 ether)); // also works after Unlock
        assertEq(lst.balanceOf(redeemer), 0.5 ether);
    }

    function test_payInstantFromUnmintedFeesMintsAtPayout() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 fee = vault.treasuryBalance();
        assertGt(fee, 0);
        assertEq(lst.balanceOf(address(vault)), 10 ether);
        _deliver(_instantMsg(id, 1, redeemer, fee / 2));
        assertEq(lst.balanceOf(redeemer), fee / 2);
        assertEq(lst.balanceOf(address(vault)), 10 ether);
    }

    function test_payInstantShortRevertsAndTheSameMessagePaysOnceFunded() public {
        uint64 id = _open(10 ether);
        _fundTreasury(0.3 ether);
        uint256 outbox = ep.outboxLength();
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, 0.5 ether, 0.3 ether));
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
        assertEq(t2, vault.treasuryBalance());
        assertGt(t2, t1);
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

    function testFuzz_treasuryClaimMatchesFeesForRandomOpens(uint8 n, uint256 seed) public {
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
        uint256 sum;
        for (uint256 i; i < n; i++) {
            PositionVault.Position memory p = vault.getPosition(ids[i]);
            uint256 acc = vault.accruedYield(ids[i]);
            // fee = gross - accrued, gross reconstructed from the per-Position coefficients (or frozen accrued)
            if (p.unlocked) sum += (acc * 2000) / 8000;
            else sum += _fee(ids[i]);
        }
        assertApproxEqAbs(vault.treasuryBalance(), sum / 2, uint256(n) * 2 + 2);
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

    function test_rateDropGivesZeroYieldNotUnderflow() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0e18);
        assertEq(vault.accruedYield(id), 0);
        vault.reportYield(id);
        _deliver(_unlockMsg(id, 1));
        assertEq(wst.balanceOf(alice), 100 ether);
    }

    // Gross yield at the moved rate is Principal * (rate now / rate at open - 1); the Yield Fee (20%) is taken
    // from it as for a SimLST, and nothing is minted.

    function test_movingRateDrivesYield() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        assertEq(vault.accruedYield(id), 0);
        wst.setRate(1.0403e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.0824 ether, 2); // 10 * (1.0403 - 1.03) * 80%
        assertEq(vault.treasuryBalance(), 0, "open fees are not spendable");
        wst.setRate(1.0506e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.1648 ether, 2);
        assertEq(vault.treasuryBalance(), 0);
        _deliver(_unlockMsg(id, 1));
        assertApproxEqAbs(
            vault.treasuryBalance(), 0.0206 ether, 4, "Tesoro's half of the fee joins the Treasury at Unlock"
        );
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
        _deliver(_unlockMsg(id, 1)); // the fee is spendable once the Position has unlocked
        uint256 fee = vault.treasuryBalance();
        assertGt(fee, 0);
        _deliver(abi.encode(uint8(5), CHAIN, id, uint64(2), bytes32(uint256(uint160(redeemer))), fee));
        assertEq(vault.instantPaid(), fee);
        assertApproxEqAbs(wst.balanceOf(redeemer) * 1.0403e18 / 1e18, fee, 2);
        // the next one finds an empty Treasury: it waits, never touching Principal
        vm.expectPartialRevert(PositionVault.InsufficientTreasury.selector);
        _deliver(abi.encode(uint8(5), CHAIN, id, uint64(3), bytes32(uint256(uint160(redeemer))), 1 ether));
    }

    function test_withdrawTreasuryPaysFromHeldSharesAndNeverMintsOrEatsPrincipal() public {
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);
        wst.setRate(1.0403e18);
        assertEq(vault.treasuryBalance(), 0, "the fee of an open Position is not withdrawable");
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, 1, 0));
        vault.withdrawTreasury(1, address(0xC0FFEE));
        _deliver(_unlockMsg(id, 1));
        assertApproxEqAbs((wst.balanceOf(alice) - 90 ether) * 1.0403e18 / 1e18, 10.3 ether, 2);
        uint256 fee = vault.treasuryBalance();
        assertGt(fee, 0);
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
        vm.expectPartialRevert(PositionVault.ExceedsAccruedYield.selector);
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
        // gross = 10 shares-worth above Principal: (10 - 0.4/1.1) * 1.2 + 0.4 - 10 = 2.327..; net 80%
        uint256 held = 10 ether - wst.balanceOf(redeemer);
        uint256 gross = held * 1.2e18 / 1e18 + 0.4 ether - 10 ether;
        assertApproxEqAbs(vault.accruedYield(id), gross - gross * 2000 / 10_000, 4);
        (,,, uint64 seq, uint256 accrued,,, uint256 treasury) =
            abi.decode(ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256, uint256));
        assertEq(seq, 2);
        assertEq(accrued, vault.accruedYield(id));
        assertEq(treasury, vault.treasuryBalance());
        assertEq(treasury, 0, "the open Position's fee is not spendable");

        uint256 claim = vault.payableYield(id);
        _deliver(_payMsg(id, 2, redeemer, claim)); // no InsufficientShares
        uint256 paid = vault.getPosition(id).paidUnderlying;
        // paid + Treasury never exceeds the value above Principal that the shares represent
        uint256 above = wst.balanceOf(address(vault)) * 1.2e18 / 1e18 + paid - 10 ether;
        uint256 fee = above * 2000 / 10_000;
        assertLe(paid + fee, above + 4);
        assertApproxEqAbs(paid + fee, above, 6, "all of it is accounted for");

        // Principal is intact for Unlock, then the Treasury (the fee) pays out in full
        _deliver(_unlockMsg(id, 3));
        assertApproxEqAbs((wst.balanceOf(alice) - 90 ether) * 1.2e18 / 1e18, 10 ether, 2);
        assertApproxEqAbs(vault.treasuryBalance(), fee / 2, 6);
        vault.withdrawTreasury(vault.treasuryBalance(), address(0xC0FFEE));
    }

    /// With several Positions the Treasury claim (from share totals) matches each Position's own fee.
    function test_realRateTreasuryClaimFollowsPayoutsAcrossPositions() public {
        wst.setRate(1e18);
        vm.startPrank(alice);
        uint64 a = vault.openPosition(10 ether, 12);
        uint64 b = vault.openPosition(5 ether, 12);
        vm.stopPrank();
        wst.setRate(1.1e18);
        _deliver(_payMsg(a, 1, redeemer, vault.payableYield(a) / 2));
        wst.setRate(1.3e18);
        _deliver(_payMsg(b, 1, redeemer, vault.payableYield(b)));
        uint256 feeA = _realGross(a) * 2000 / 10_000;
        uint256 feeB = _realGross(b) * 2000 / 10_000;
        assertEq(vault.treasuryBalance(), 0, "open fees are not spendable");
        _deliver(_unlockMsg(b, 2));
        assertApproxEqAbs(vault.treasuryBalance(), feeB / 2, 6, "only the unlocked Position's fee, Tesoro's half");
        _deliver(_unlockMsg(a, 2));
        assertApproxEqAbs(vault.treasuryBalance(), (feeA + feeB) / 2, 8);
    }

    function _realGross(uint64 id) internal view returns (uint256) {
        PositionVault.Position memory p = vault.getPosition(id);
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
