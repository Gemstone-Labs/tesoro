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
        lst = new SimLST(address(this));
        ep = new MockEndpoint();
        vault = new PositionVault(address(lst), address(lst), address(ep), CHAIN);
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
        (,,, uint64 s1, uint256 a1,,) =
            abi.decode(ep.outboxPayload(1), (uint8, uint32, uint64, uint64, uint256, uint256, uint256));
        (,,, uint64 s2, uint256 a2,,) =
            abi.decode(ep.outboxPayload(2), (uint8, uint32, uint64, uint64, uint256, uint256, uint256));
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
        assertEq(vault.getPosition(id).paidUnderlying, accrued / 2, "older PayYield was dropped");
        uint256 bal = lst.balanceOf(redeemer);
        _deliver(_payMsg(id, 2, redeemer, accrued / 4)); // replay
        _deliver(_payMsg(id, 3, redeemer, accrued / 4)); // replay
        assertEq(lst.balanceOf(redeemer), bal);
        assertEq(vault.getPosition(id).paidUnderlying, accrued / 2);
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
        vault = new PositionVault(address(wst), address(adapter), address(ep), CHAIN);
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
        assertEq(vault.accruedYield(id), 0.103 ether); // 10 * (1.0403 - 1.03)
        wst.setRate(1.0506e18);
        assertEq(vault.accruedYield(id), 0.206 ether);
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
        _deliver(_payMsg(id, 1, redeemer, 0.05 ether));
        uint256 worth = wst.balanceOf(redeemer) * 1.0403e18 / 1e18;
        assertGe(worth, 0.05 ether - 1);
        assertLe(worth, 0.05 ether + 2);
    }
}
