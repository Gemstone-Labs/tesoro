// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {
    MessagingParams,
    MessagingFee,
    MessagingReceipt
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";

contract MockLzEndpoint {
    uint32 public eid = 40449;
    uint256 public fee = 0.0001 ether;
    MessagingParams public last;
    uint256 public lastValue;
    address public lastRefund;
    uint256 public sends;

    function setDelegate(address) external {}

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(fee, 0);
    }

    function send(MessagingParams calldata p, address refund) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= fee, "fee");
        last = p;
        lastValue = msg.value;
        lastRefund = refund;
        sends++;
        if (msg.value > fee) {
            (bool ok,) = refund.call{value: msg.value - fee}("");
            require(ok, "refund");
        }
        r.fee = MessagingFee(fee, 0);
    }

    function lastMessage() external view returns (bytes memory) {
        return last.message;
    }

    function lastOptions() external view returns (bytes memory) {
        return last.options;
    }
}

contract PositionVaultOAppTest is Test {
    uint32 constant HOODI = 40449;
    uint32 constant SOLANA = 40168;
    bytes32 constant STORE = bytes32(uint256(0xabc123));

    MockLzEndpoint ep;
    SimLST lst;
    PositionVaultOApp vault;
    address alice = address(0xA11CE);
    address redeemer = address(0xEDEE);

    function setUp() public {
        ep = new MockLzEndpoint();
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        vault =
            new PositionVaultOApp(address(lst), address(lst), address(ep), HOODI, SOLANA, address(this), address(lst));
        lst.setMinter(address(vault));
        vault.setPeer(SOLANA, STORE);
        lst.faucet(alice);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        lst.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
    }

    function _key(uint64 id) internal view returns (bytes32) {
        return bytes32((uint256(uint160(address(vault))) << 96) | (uint256(id) << 32));
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition{value: 0.0002 ether}(amt, 3);
    }

    function _recv(bytes memory m) internal {
        vm.prank(address(ep));
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
    }

    function _unlock(uint64 id, uint64 seq) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(3), HOODI, _key(id), seq, uint128(0));
    }

    function _pay(uint64 id, uint64 seq, address to, uint128 amt) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(4), HOODI, _key(id), seq, bytes32(uint256(uint160(to))), amt);
    }

    function test_open_sends_packed_position_locked_and_refunds_excess() public {
        uint256 before = alice.balance;
        uint64 id = _open(1e18);
        assertEq(ep.sends(), 1);
        assertEq(before - alice.balance, ep.fee(), "caller pays exactly the fee");
        bytes memory m = ep.lastMessage();
        assertEq(m.length, 126);
        assertEq(uint8(m[0]), 1);
        assertEq(bytes4(_slice(m, 1, 4)), bytes4(HOODI));
        assertEq(bytes32(_slice(m, 5, 32)), _key(id));
        assertEq(bytes8(_slice(m, 37, 8)), bytes8(uint64(1)));
        assertEq(bytes32(_slice(m, 45, 32)), bytes32(uint256(uint160(alice))));
        assertEq(bytes32(_slice(m, 77, 32)), bytes32(uint256(uint160(address(lst)))));
        assertEq(bytes16(_slice(m, 109, 16)), bytes16(uint128(vault.getPosition(id).principalUnderlying)));
        assertEq(uint8(m[125]), 3);
        assertEq(ep.lastOptions(), abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), uint128(200_000)));
    }

    function test_open_reverts_without_the_fee() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.openPosition(1e18, 3);
    }

    function test_report_yield_sends_cumulative_accrued() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 accrued = vault.accruedYield(id);
        assertGt(accrued, 0);
        vault.reportYield{value: 0.0001 ether}(id);
        bytes memory m = ep.lastMessage();
        assertEq(m.length, 101);
        assertEq(uint8(m[0]), 2);
        assertEq(bytes8(_slice(m, 37, 8)), bytes8(uint64(2)));
        assertEq(bytes16(_slice(m, 45, 16)), bytes16(uint128(accrued)));
        assertGt(vault.treasuryBalance(), 0);
        assertEq(bytes16(_slice(m, 61, 16)), bytes16(uint128(vault.treasuryBalance())));
    }

    function test_report_carries_the_cumulative_instant_paid() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 half = vault.treasuryBalance() / 2;
        _recv(_instant(id, 1, redeemer, uint128(half)));
        vault.reportYield{value: 0.0001 ether}(id);
        bytes memory m = ep.lastMessage();
        assertEq(m.length, 101);
        assertEq(uint64(bytes8(_slice(m, 93, 8))), uint64(block.timestamp), "report time");
        assertEq(bytes16(_slice(m, 61, 16)), bytes16(uint128(vault.treasuryBalance())));
        assertEq(bytes16(_slice(m, 77, 16)), bytes16(uint128(half)));
        assertEq(vault.instantPaid(), half);
    }

    function _instant(uint64 id, uint64 seq, address to, uint128 amt) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(5), HOODI, _key(id), seq, bytes32(uint256(uint160(to))), amt);
    }

    function test_pay_instant_pays_from_the_treasury() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 treasury = vault.treasuryBalance();
        assertGt(treasury, 1000);
        _recv(_instant(id, 1, redeemer, uint128(treasury / 2)));
        assertEq(lst.balanceOf(redeemer), treasury / 2);
        assertEq(vault.instantPaid(), treasury / 2);
        assertApproxEqAbs(vault.treasuryBalance(), treasury - treasury / 2, 1);
        _recv(_instant(id, 1, redeemer, uint128(treasury / 2))); // replay
        assertEq(lst.balanceOf(redeemer), treasury / 2);
    }

    function test_pay_instant_short_reverts_over_the_wire_and_sends_nothing() public {
        uint64 id = _open(1e18);
        uint256 sendsBefore = ep.sends();
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, 1e17, 0));
        _recv(_instant(id, 4, redeemer, 1e17)); // empty Treasury: the message waits
        assertEq(lst.balanceOf(redeemer), 0);
        assertEq(ep.sends(), sendsBefore);
    }

    function test_withdraw_treasury_is_owner_only() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 treasury = vault.treasuryBalance();
        vm.prank(alice);
        vm.expectRevert();
        vault.withdrawTreasury(1, alice);
        vault.withdrawTreasury(treasury / 2, redeemer);
        assertEq(lst.balanceOf(redeemer), treasury / 2);
        assertEq(id, 1);
    }

    function test_pay_instant_rejects_wrong_length() public {
        uint64 id = _open(1e18);
        vm.expectRevert(PositionVaultOApp.InvalidMessageLength.selector);
        _recv(abi.encodePacked(uint8(5), HOODI, _key(id), uint64(1), uint128(0)));
    }

    function test_treasury_admin_is_the_owner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setYieldFeeBps(100);
        vault.setYieldFeeBps(100);
        assertEq(vault.yieldFeeBps(), 100);
    }

    function test_quotes() public view {
        assertEq(vault.quotePositionLocked(), ep.fee());
        assertEq(vault.quoteYieldAccrued(), ep.fee());
    }

    function test_unlock_releases_principal_once() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 before = lst.balanceOf(alice);
        _recv(_unlock(id, 1));
        assertGt(lst.balanceOf(alice), before);
        assertTrue(vault.getPosition(id).unlocked);
        uint256 after1 = lst.balanceOf(alice);
        _recv(_unlock(id, 1)); // replay: no-op
        assertEq(lst.balanceOf(alice), after1);
    }

    function test_pay_yield_is_bounded_by_reported_accrual() public {
        uint64 id = _open(1e18);
        vm.warp(block.timestamp + 600);
        uint256 avail = vault.payableYield(id);
        assertGt(avail, 0);
        _recv(_pay(id, 1, redeemer, uint128(avail / 2)));
        assertGt(lst.balanceOf(redeemer), 0);
        vm.expectRevert();
        _recv(_pay(id, 2, redeemer, uint128(avail)));
    }

    function test_rejects_other_vaults_positions_unknown_peers_and_bad_lengths() public {
        uint64 id = _open(1e18);
        bytes memory foreign = abi.encodePacked(
            uint8(3), HOODI, bytes32((uint256(0xdead) << 96) | (uint256(id) << 32)), uint64(1), uint128(0)
        );
        vm.expectRevert(PositionVaultOApp.WrongVault.selector);
        _recv(foreign);

        vm.prank(address(ep));
        vm.expectRevert();
        vault.lzReceive(Origin(SOLANA, bytes32(uint256(0xbad)), 1), bytes32(0), _unlock(id, 1), address(0), "");

        vm.expectRevert(PositionVaultOApp.InvalidMessageLength.selector);
        _recv(abi.encodePacked(uint8(3), HOODI, _key(id), uint64(1)));
        vm.expectRevert(PositionVaultOApp.InvalidMessageType.selector);
        _recv(abi.encodePacked(uint8(1), HOODI, _key(id), uint64(1), uint128(0)));
    }

    function test_only_lz_endpoint_can_deliver() public {
        uint64 id = _open(1e18);
        vm.expectRevert();
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), _unlock(id, 1), address(0), "");
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
