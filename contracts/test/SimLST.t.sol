// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimLST} from "../src/SimLST.sol";

contract SimLSTTest is Test {
    SimLST lst;
    address admin = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        vm.prank(admin);
        lst = new SimLST(admin);
        vm.deal(user, 100 ether);
        vm.deal(admin, 100 ether);
    }

    function test_rateStartsAtOne() public view {
        assertEq(lst.underlyingPerShare(), 1e18);
    }

    function test_rateGrowsOneMonthPerTenMinutes() public {
        vm.warp(block.timestamp + 10 minutes);
        // 5% APY for 30 simulated days
        uint256 expected = 1e18 + (uint256(1e18) * 500 * 4320 * 10 minutes) / (10_000 * 365 days);
        assertEq(lst.underlyingPerShare(), expected);
    }

    function test_rateMonotonic() public {
        uint256 prev = lst.underlyingPerShare();
        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + 7 minutes);
            uint256 r = lst.underlyingPerShare();
            assertGe(r, prev);
            prev = r;
        }
    }

    function test_setParamsCheckpointsRate() public {
        vm.warp(block.timestamp + 10 minutes);
        uint256 before = lst.underlyingPerShare();
        vm.prank(admin);
        lst.setRateParams(1000, 1);
        assertEq(lst.underlyingPerShare(), before);
        vm.warp(block.timestamp + 365 days);
        assertEq(lst.underlyingPerShare(), before + (before * 1000) / 10_000);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(user);
        vm.expectRevert(SimLST.NotOwner.selector);
        lst.setRateParams(1, 1);
        vm.prank(user);
        vm.expectRevert(SimLST.NotOwner.selector);
        lst.setPaused(true);
    }

    function test_depositWithdrawRoundTripAtRate() public {
        vm.prank(user);
        uint256 shares = lst.deposit{value: 10 ether}();
        assertEq(shares, 10 ether);
        vm.warp(block.timestamp + 10 minutes);
        uint256 rate = lst.underlyingPerShare();
        vm.prank(admin);
        (bool ok,) = address(lst).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 before = user.balance;
        vm.prank(user);
        uint256 out = lst.withdraw(shares);
        assertEq(out, (shares * rate) / 1e18);
        assertEq(user.balance - before, out);
    }

    function test_withdrawRefusedBeyondReserve() public {
        vm.prank(user);
        uint256 shares = lst.deposit{value: 10 ether}();
        vm.warp(block.timestamp + 60 minutes); // 6 sim months of yield, reserve unfunded
        vm.prank(user);
        vm.expectRevert();
        lst.withdraw(shares);
    }

    function test_pauseBlocksDepositAndFaucet() public {
        vm.prank(admin);
        lst.setPaused(true);
        vm.prank(user);
        vm.expectRevert(SimLST.IsPaused.selector);
        lst.deposit{value: 1 ether}();
        vm.expectRevert(SimLST.IsPaused.selector);
        lst.faucet(user);
    }

    function test_faucetRateLimited() public {
        lst.faucet(user);
        assertEq(lst.balanceOf(user), 10 ether);
        vm.expectRevert();
        lst.faucet(user);
        vm.warp(block.timestamp + 1 hours);
        lst.faucet(user);
        assertEq(lst.balanceOf(user), 20 ether);
    }

    function test_erc20Transfers() public {
        lst.faucet(user);
        vm.prank(user);
        lst.approve(address(this), 4 ether);
        lst.transferFrom(user, address(1), 4 ether);
        assertEq(lst.balanceOf(address(1)), 4 ether);
        vm.expectRevert(SimLST.InsufficientAllowance.selector);
        lst.transferFrom(user, address(1), 1);
    }
}
