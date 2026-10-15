// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {IRateSource, IKinetiqAccountant} from "../src/IRateSource.sol";
import {StakeZap, LidoZap, KinetiqZap} from "../src/StakeZap.sol";
import {MockLzEndpoint} from "./PositionVaultOApp.t.sol";

abstract contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

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

/// Lido's wstETH: ETH sent to it is staked and mints wstETH (shares) at stETH-per-token `rate`.
contract MockWstETH is MockToken {
    uint256 public stEthPerToken = 1.2e18;
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }

    receive() external payable {
        require(!paused, "STAKING_PAUSED");
        balanceOf[msg.sender] += msg.value * 1e18 / stEthPerToken;
    }
}

/// Kinetiq: StakingManager.stake() mints kHYPE to the caller; accountant gives HYPE per kHYPE.
contract MockKinetiqStack is MockToken, IKinetiqAccountant {
    uint256 public rate = 1.025e18;
    uint256 public minStakeAmount = 5 ether;

    error StakeBelowMinimum();

    function kHYPEToHYPE(uint256 a) external view returns (uint256) {
        return a * rate / 1e18;
    }

    function stake() external payable {
        if (msg.value < minStakeAmount) revert StakeBelowMinimum();
        balanceOf[msg.sender] += msg.value * 1e18 / rate;
    }
}

contract StakeZapTest is Test {
    uint32 constant SOLANA = 40168;
    bytes32 constant STORE = bytes32(uint256(0x5702E));
    MockLzEndpoint lz;
    MockWstETH wst;
    MockKinetiqStack kin;
    PositionVaultOApp ethVault;
    PositionVaultOApp hypeVault;
    LidoZap lido;
    KinetiqZap kinetiq;
    address alice = address(0xA11CE);
    uint256 constant FEE = 0.0001 ether;

    function setUp() public {
        lz = new MockLzEndpoint();
        wst = new MockWstETH();
        kin = new MockKinetiqStack();
        ethVault = new PositionVaultOApp(
            address(wst), address(new WstETHRateAdapter(address(wst))), address(lz), lz.eid(), SOLANA, address(this), address(0)
        );
        hypeVault = new PositionVaultOApp(
            address(kin), address(new KHypeRateAdapter(address(kin))), address(lz), lz.eid(), SOLANA, address(this), address(0)
        );
        ethVault.setPeer(SOLANA, STORE);
        hypeVault.setPeer(SOLANA, STORE);
        lido = new LidoZap(address(ethVault), address(wst));
        kinetiq = new KinetiqZap(address(hypeVault), address(kin), address(kin));
        vm.deal(alice, 100 ether);
    }

    function test_lido_stakesAndOpensForThePlayerInOneCall() public {
        vm.prank(alice);
        (uint64 id, uint256 got) = lido.openWithNative{value: 10 ether + 3 * FEE}(10 ether, 0, 12);
        assertEq(got, uint256(10 ether) * 1e18 / 1.2e18);
        PositionVault.Position memory p = ethVault.getPosition(id);
        assertEq(p.owner, alice, "the Player owns it, not the zap");
        assertEq(p.principalShares, got);
        assertApproxEqAbs(p.principalUnderlying, 10 ether, 2, "Principal = the ETH staked");
        assertEq(wst.balanceOf(address(ethVault)), got);
        assertEq(wst.balanceOf(address(lido)), 0);
        assertEq(address(lido).balance, 0, "the zap keeps nothing");
        assertEq(alice.balance, 90 ether - FEE, "only stake + the real LayerZero fee are spent; excess refunded");
        assertEq(lz.sends(), 1);
    }

    function test_kinetiq_stakesAndOpensForThePlayerInOneCall() public {
        vm.prank(alice);
        (uint64 id, uint256 got) = kinetiq.openWithNative{value: 10 ether + 2 * FEE}(10 ether, 0, 6);
        PositionVault.Position memory p = hypeVault.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(p.principalShares, got);
        assertApproxEqAbs(p.principalUnderlying, 10 ether, 2);
        assertEq(p.horizonMonths, 6);
        assertEq(kin.balanceOf(address(kinetiq)), 0);
        assertEq(address(kinetiq).balance, 0);
        assertEq(alice.balance, 90 ether - FEE);
    }

    function test_kinetiq_belowTheMinimumRevertsAndTheCoinStays() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(MockKinetiqStack.StakeBelowMinimum.selector);
        kinetiq.openWithNative{value: 1 ether + FEE}(1 ether, 0, 12);
        assertEq(alice.balance, before, "nothing taken");
        assertEq(hypeVault.nextPositionId(), 0);
    }

    function test_lido_pausedStakingRevertsAndTheCoinStays() public {
        wst.setPaused(true);
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert();
        lido.openWithNative{value: 1 ether + FEE}(1 ether, 0, 12);
        assertEq(alice.balance, before);
    }

    function test_shortLayerZeroFeeRevertsAfterStakingSoNothingIsStranded() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(); // the endpoint refuses the fee after the stake happened: the whole call unwinds
        kinetiq.openWithNative{value: 10 ether + FEE - 1}(10 ether, 0, 12);
        assertEq(alice.balance, before, "coin back");
        assertEq(kin.balanceOf(address(kinetiq)), 0, "no kHYPE left in the zap");
        assertEq(kin.balanceOf(alice), 0);
        assertEq(hypeVault.nextPositionId(), 0);
    }

    function test_minLstProtectsFromAWorseRate() public {
        uint256 expected = uint256(10 ether) * 1e18 / 1.2e18;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakeZap.StakedTooLittle.selector, expected, expected + 1));
        lido.openWithNative{value: 10 ether + FEE}(10 ether, expected + 1, 12);
    }

    function test_zeroStakeAndBadHorizonRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(StakeZap.ZeroStake.selector);
        lido.openWithNative{value: FEE}(0, 0, 12);
        vm.expectRevert(PositionVault.BadHorizon.selector);
        lido.openWithNative{value: 1 ether + FEE}(1 ether, 0, 13);
        vm.stopPrank();
    }

    function test_onlyTheVaultCanSendCoinToTheZap() public {
        vm.prank(alice);
        (bool ok,) = address(lido).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_theTokenPathStillWorks() public {
        vm.startPrank(alice);
        (bool ok,) = address(wst).call{value: 5 ether}("");
        assertTrue(ok);
        uint256 bal = wst.balanceOf(alice);
        wst.approve(address(ethVault), bal);
        uint64 id = ethVault.openPosition{value: FEE}(bal, 12);
        vm.stopPrank();
        assertEq(ethVault.getPosition(id).owner, alice);
    }

    function test_openPositionForRejectsZeroOwner() public {
        vm.expectRevert(PositionVault.ZeroAmount.selector);
        ethVault.openPositionFor(address(0), 1, 12);
    }
}
