// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { TesoroSpikeOApp } from "../../src/spike/TesoroSpikeOApp.sol";

contract MockEndpoint {
    function eid() external pure returns (uint32) {
        return 40449;
    }

    function setDelegate(address) external { }
}

contract TesoroSpikeOAppTest is Test {
    MockEndpoint ep;
    TesoroSpikeOApp app;
    bytes32 constant SOLANA_PEER = bytes32(uint256(0xabc));
    bytes32 constant POS = bytes32(uint256(7));

    function setUp() public {
        ep = new MockEndpoint();
        app = new TesoroSpikeOApp(address(ep), address(this));
        app.setPeer(40168, SOLANA_PEER);
    }

    function _msg(uint8 t, uint32 src, uint64 seq, uint128 amt) internal pure returns (bytes memory) {
        return abi.encodePacked(t, src, POS, seq, amt);
    }

    function _recv(bytes32 sender, uint32 srcEid, bytes memory m) internal {
        vm.prank(address(ep));
        app.lzReceive(Origin(srcEid, sender, 1), bytes32(0), m, address(0), "");
    }

    function test_applies_and_ignores_replay_and_stale() public {
        _recv(SOLANA_PEER, 40168, _msg(3, 40449, 2, 100));
        (uint64 seq,, uint128 amt) = app.lastIn(POS);
        assertEq(seq, 2);
        assertEq(amt, 100);
        _recv(SOLANA_PEER, 40168, _msg(4, 40449, 2, 999)); // replay
        _recv(SOLANA_PEER, 40168, _msg(4, 40449, 1, 999)); // stale
        (seq,, amt) = app.lastIn(POS);
        assertEq(seq, 2);
        assertEq(amt, 100);
        _recv(SOLANA_PEER, 40168, _msg(4, 40449, 3, 50));
        (seq,, amt) = app.lastIn(POS);
        assertEq(seq, 3);
        assertEq(amt, 50);
    }

    function test_rejects_unknown_peer() public {
        vm.expectRevert();
        _recv(bytes32(uint256(0xdead)), 40168, _msg(3, 40449, 1, 1));
        vm.expectRevert();
        _recv(SOLANA_PEER, 40999, _msg(3, 40449, 1, 1));
    }

    function test_rejects_bad_messages() public {
        vm.expectRevert(TesoroSpikeOApp.InvalidSourceChain.selector);
        _recv(SOLANA_PEER, 40168, _msg(3, 40362, 1, 1));
        vm.expectRevert(TesoroSpikeOApp.InvalidMessageType.selector);
        _recv(SOLANA_PEER, 40168, _msg(1, 40449, 1, 1));
        vm.expectRevert(TesoroSpikeOApp.InvalidSeq.selector);
        _recv(SOLANA_PEER, 40168, _msg(3, 40449, 0, 1));
        vm.expectRevert(TesoroSpikeOApp.InvalidMessageLength.selector);
        _recv(SOLANA_PEER, 40168, hex"0102");
    }

    function test_sender_only_endpoint() public {
        vm.expectRevert();
        app.lzReceive(Origin(40168, SOLANA_PEER, 1), bytes32(0), _msg(3, 40449, 1, 1), address(0), "");
    }
}
