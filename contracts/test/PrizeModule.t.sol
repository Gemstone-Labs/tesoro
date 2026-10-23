// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrizeModule} from "../src/PrizeModule.sol";

/// The module is only meant to run by delegatecall from its vault. Called directly it must refuse, so nobody can
/// drive it against its own (empty) storage and mistake the result for a vault's.
contract PrizeModuleTest is Test {
    PrizeModule module;

    function setUp() public {
        module = new PrizeModule(address(0x11), address(0x12), address(0x13), 1, address(0));
    }

    function test_receivePayloadRefusesADirectCall() public {
        vm.expectRevert(PrizeModule.DirectCall.selector);
        module.receivePayload(abi.encode(uint8(6), uint32(1), uint64(1), uint64(0)));
    }

    function test_receiveWireRefusesADirectCall() public {
        vm.expectRevert(PrizeModule.DirectCall.selector);
        module.receiveWire(1, 1, new bytes(157));
    }

    function test_encodeResultIsPureWireEncoding() public view {
        address vault = address(0xAB);
        bytes memory out =
            module.encodeResult(abi.encode(uint8(9), uint32(7), uint64(5), uint64(0), uint8(1), uint128(42)), vault);
        assertEq(
            out,
            abi.encodePacked(
                uint8(9), uint32(7), bytes32(uint256(uint160(vault)) << 96), uint64(5), uint8(1), uint128(42)
            )
        );
        assertEq(out.length, 62);
    }
}
