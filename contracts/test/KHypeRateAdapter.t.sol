// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {IKinetiqAccountant} from "../src/IRateSource.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";
import {MockLzEndpoint} from "./PositionVaultOApp.t.sol";

/// Stands in for Kinetiq's StakingAccountant (HYPE per kHYPE, linear in the amount) and holds the kHYPE balances.
contract MockKinetiq is IKinetiqAccountant {
    uint256 public rate = 1e18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setRate(uint256 r) external {
        rate = r;
    }

    function kHYPEToHYPE(uint256 a) external view returns (uint256) {
        return a * rate / 1e18;
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

contract KHypeRateAdapterTest is Test {
    uint32 constant CHAIN = 40362;
    uint32 constant SOLANA = 40168;
    bytes32 constant STORE = bytes32(uint256(0x5702E));
    MockKinetiq kh;
    KHypeRateAdapter adapter;
    PositionVault vault;
    MockEndpoint ep;
    address alice = address(0xA11CE);

    function setUp() public {
        kh = new MockKinetiq();
        adapter = new KHypeRateAdapter(address(kh));
        ep = new MockEndpoint();
        vault = new PositionVault(address(kh), address(adapter), address(ep), CHAIN, address(0));
        kh.mint(alice, 100 ether);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        kh.approve(address(vault), type(uint256).max);
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition(amt, 12);
    }

    function test_adapterReadsTheAccountantRate() public {
        assertEq(adapter.underlyingPerShare(), 1e18);
        kh.setRate(1.026e18);
        assertEq(adapter.underlyingPerShare(), 1.026e18);
    }

    function test_openPricesPrincipalInHypeAtTheRate() public {
        kh.setRate(1.02e18);
        uint64 id = _open(10 ether);
        assertEq(vault.getPosition(id).principalUnderlying, 10.2 ether);
    }

    function test_yieldFromRateGrowthWithTwentyPercentFeeAtTheSource() public {
        uint64 id = _open(10 ether);
        kh.setRate(1.05e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.4 ether, 2, "Position keeps 80% of 0.5 HYPE");
        assertEq(vault.treasuryBalance(), 0, "the fee of an open Position is not spendable");
        assertEq(kh.balanceOf(address(vault)), vault.getPosition(id).heldShares);
        ep.deliver(address(vault), abi.encode(uint8(3), CHAIN, id, uint64(1)));
        assertApproxEqAbs(
            vault.treasuryBalance(), 0.05 ether, 2, "Treasury gets 10% once the Position unlocks, the Pool 10%"
        );
    }

    function test_slashingLowersTheRateAndTheYieldFollowsItDown() public {
        uint64 id = _open(10 ether);
        kh.setRate(1.05e18);
        kh.setRate(1.0e18); // slashing: the rate falls, nothing is owed
        assertEq(vault.treasuryBalance(), 0, "no fee on a fall");
        assertEq(vault.accruedYield(id), 0);
        kh.setRate(1.05e18);
        assertEq(vault.treasuryBalance(), 0, "open fees are never spendable");
        assertGt(vault.accruedYield(id), 0);
    }

    function test_reportIs93BytesOverLayerZero() public {
        MockLzEndpoint lz = new MockLzEndpoint();
        PositionVaultOApp v = new PositionVaultOApp(
            address(kh), address(adapter), address(lz), lz.eid(), SOLANA, address(this), address(0)
        );
        v.setPeer(SOLANA, STORE);
        vm.startPrank(alice);
        kh.approve(address(v), type(uint256).max);
        uint64 id = v.openPosition{value: 0.0002 ether}(10 ether, 12);
        vm.stopPrank();
        kh.setRate(1.05e18);
        vm.prank(alice);
        v.reportYield{value: 0.0001 ether}(id);
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 133);
        assertEq(uint8(m[0]), 2);
        assertApproxEqAbs(uint128(bytes16(_slice(m, 45, 16))), 0.4 ether, 2);
        assertEq(uint128(bytes16(_slice(m, 61, 16))), 0, "the open Position's fee is not in the Treasury figure");
        assertEq(uint128(bytes16(_slice(m, 77, 16))), 0, "no Instant payout yet");
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
