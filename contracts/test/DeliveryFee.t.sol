// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultBase} from "../src/PositionVaultBase.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";

/// The Delivery Fee: Solana asks the vault to keep a flat amount of the payout for the LayerZero send Tesoro's sponsor
/// paid in SOL. The vault keeps no more than its own cap and a tenth of the payout, and never reverts on the fee.
contract DeliveryFeeTest is Test {
    uint32 constant CHAIN = 40449;
    SimLST lst;
    PositionVault vault;
    MockEndpoint ep;
    address alice = address(0xA11CE);
    address redeemer = address(0xEDEE);
    address tesoro = address(0x7E50);

    function setUp() public {
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        ep = new MockEndpoint();
        vault = new PositionVault(address(lst), address(lst), address(ep), CHAIN, address(lst));
        lst.setMinter(address(vault));
        lst.faucet(alice);
        vm.prank(alice);
        lst.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
        vault.setDelivery(tesoro, 0.5 ether);
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition(amt, 3);
    }

    function _unlock(uint64 id, uint64 seq, uint256 deliveryFee) internal {
        ep.deliver(address(vault), abi.encode(uint8(10), CHAIN, id, seq, deliveryFee));
    }

    function _pay(uint64 id, uint64 seq, address to, uint256 amt, uint256 fee, uint256 deliveryFee) internal {
        ep.deliver(
            address(vault),
            abi.encode(uint8(11), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt, fee, uint256(0), deliveryFee)
        );
    }

    function _instant(uint64 id, uint64 seq, address to, uint256 amt, uint256 deliveryFee) internal {
        ep.deliver(
            address(vault), abi.encode(uint8(12), CHAIN, id, seq, bytes32(uint256(uint160(to))), amt, deliveryFee)
        );
    }

    function test_ben_unlocking_ten_eth_pays_the_flat_fee_and_gets_the_rest() public {
        uint64 id = _open(10 ether);
        uint256 before = lst.balanceOf(alice);
        _unlock(id, 1, 0.001 ether);
        assertEq(lst.balanceOf(tesoro), 0.001 ether);
        assertEq(lst.balanceOf(alice) - before, 10 ether - 0.001 ether);
    }

    function test_a_fee_above_the_admin_cap_shrinks_to_the_cap() public {
        uint64 id = _open(10 ether);
        _unlock(id, 1, 3 ether); // asks for 3, the vault allows 0.5
        assertEq(lst.balanceOf(tesoro), 0.5 ether);
    }

    function test_a_fee_above_a_tenth_of_the_payout_shrinks_to_a_tenth() public {
        vault.setDelivery(tesoro, 100 ether);
        uint64 id = _open(10 ether);
        _unlock(id, 1, 5 ether);
        assertEq(lst.balanceOf(tesoro), 1 ether, "10% of 10 ether");
    }

    function test_the_admin_cap_cannot_lift_the_ten_percent_ceiling() public {
        vault.setDelivery(tesoro, type(uint256).max);
        uint64 id = _open(0.01 ether);
        uint256 before = lst.balanceOf(alice);
        _unlock(id, 1, type(uint128).max);
        assertEq(lst.balanceOf(tesoro), 0.001 ether);
        assertEq(lst.balanceOf(alice) - before, 0.009 ether);
    }

    function test_without_a_recipient_the_player_gets_everything() public {
        vault.setDelivery(address(0), 0.5 ether);
        uint64 id = _open(10 ether);
        uint256 before = lst.balanceOf(alice);
        _unlock(id, 1, 0.001 ether);
        assertEq(lst.balanceOf(alice) - before, 10 ether);
        assertEq(lst.balanceOf(tesoro), 0);
    }

    function test_a_recipient_that_cannot_receive_never_holds_a_payout_up() public {
        uint64 id = _open(10 ether);
        vm.mockCallRevert(
            address(lst), abi.encodeWithSelector(lst.transfer.selector, tesoro, 0.001 ether), bytes("blocked")
        );
        uint256 before = lst.balanceOf(alice);
        _unlock(id, 1, 0.001 ether);
        assertTrue(vault.getPosition(id).unlocked);
        assertEq(lst.balanceOf(alice) - before, 10 ether, "the Player is paid the fee too");
    }

    function test_pay_yield_keeps_the_fee_out_of_the_holders_share() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        uint256 yieldFee = amount / 5;
        _pay(id, 1, redeemer, amount, yieldFee, 0.01 ether);
        assertEq(lst.balanceOf(tesoro), 0.01 ether);
        assertEq(lst.balanceOf(redeemer), amount - yieldFee - 0.01 ether);
    }

    function test_a_refill_into_the_vault_pays_no_delivery_fee() public {
        uint64 id = _open(10 ether);
        vm.warp(block.timestamp + 20 minutes);
        uint256 amount = vault.payableYield(id) / 2;
        _pay(id, 1, address(vault), amount, 0, 0.01 ether);
        assertEq(lst.balanceOf(tesoro), 0);
    }

    function test_instant_redeem_pays_the_fee_from_the_players_payout() public {
        uint64 id = _open(10 ether);
        lst.faucet(address(this));
        lst.approve(address(vault), type(uint256).max);
        vault.fundTreasury(1 ether);
        _instant(id, 1, redeemer, 0.4 ether, 0.01 ether);
        assertEq(lst.balanceOf(tesoro), 0.01 ether);
        assertEq(lst.balanceOf(redeemer), 0.39 ether);
        assertEq(vault.instantPaid(), 0.4 ether, "the Treasury paid the whole 0.4");
    }

    function test_only_the_admin_sets_the_terms() public {
        vm.prank(alice);
        vm.expectRevert(PositionVaultBase.NotAdmin.selector);
        vault.setDelivery(alice, type(uint256).max);
    }
}
