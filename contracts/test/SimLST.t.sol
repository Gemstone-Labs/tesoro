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
        lst = new SimLST(admin, "Simulated Staked ETH", "simETH");
        vm.deal(user, 100 ether);
        vm.deal(admin, 100 ether);
    }

    function test_rateStartsAtOne() public view {
        assertEq(lst.underlyingPerShare(), 1e18);
    }

    function test_rateIsConstant() public {
        vm.warp(block.timestamp + 10 minutes);
        assertEq(lst.underlyingPerShare(), 1e18);
        vm.warp(block.timestamp + 400 days);
        assertEq(lst.underlyingPerShare(), 1e18);
    }

    function test_setParamsKeepsRate() public {
        vm.prank(admin);
        lst.setRateParams(1000, 1);
        vm.warp(block.timestamp + 365 days);
        assertEq(lst.underlyingPerShare(), 1e18);
        assertEq(lst.apyBps(), 1000);
    }

    function test_onlyMinterMints() public {
        vm.prank(user);
        vm.expectRevert(SimLST.NotMinter.selector);
        lst.mint(user, 1 ether);
        vm.prank(admin);
        lst.setMinter(user);
        vm.prank(user);
        lst.mint(user, 1 ether);
        assertEq(lst.balanceOf(user), 1 ether);
        vm.prank(admin);
        lst.setMinter(address(0xDEAD));
        vm.prank(user);
        vm.expectRevert(SimLST.NotMinter.selector);
        lst.mint(user, 1 ether);
    }

    function test_onlyOwnerSetsMinter() public {
        vm.prank(user);
        vm.expectRevert(SimLST.NotOwner.selector);
        lst.setMinter(user);
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
        vm.prank(admin);
        lst.setMinter(admin);
        vm.prank(admin);
        lst.mint(user, 5 ether); // minted yield, reserve unfunded
        vm.prank(user);
        vm.expectRevert();
        lst.withdraw(shares + 5 ether);
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
