// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";

/// Optional: runs against HyperEVM mainnet state, skipped unless HYPEREVM_MAINNET_RPC is set.
///   HYPEREVM_MAINNET_RPC=<url> forge test --match-contract KHypeMainnetForkTest
contract KHypeMainnetForkTest is Test {
    address constant KHYPE = 0xfD739d4e423301CE9385c1fb8850539D657C296D;
    address constant ACCOUNTANT = 0x9209648Ec9D448EF57116B73A2f081835643dc7A;

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("HYPEREVM_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function test_adapterReadsRealKHypeRate() public {
        if (!forked) vm.skip(true, "HYPEREVM_MAINNET_RPC not set");
        assertEq(block.chainid, 999);
        uint256 r = new KHypeRateAdapter(ACCOUNTANT).underlyingPerShare();
        assertGt(r, 1e18, "kHYPE is worth more than 1 HYPE");
        assertLt(r, 2e18, "and less than 2");
    }

    function test_vaultYieldFollowsTheRealRate() public {
        if (!forked) vm.skip(true, "HYPEREVM_MAINNET_RPC not set");
        KHypeRateAdapter a = new KHypeRateAdapter(ACCOUNTANT);
        MockEndpoint ep = new MockEndpoint();
        PositionVault vault = new PositionVault(KHYPE, address(a), address(ep), 30367, address(0));
        address alice = address(0xA11CE);
        deal(KHYPE, alice, 10 ether);
        vm.startPrank(alice);
        (bool ok,) = KHYPE.call(abi.encodeWithSignature("approve(address,uint256)", address(vault), type(uint256).max));
        require(ok, "approve");
        uint64 id = vault.openPosition(5 ether, 12);
        vm.stopPrank();
        assertEq(vault.accruedYield(id), 0);
        uint256 rate = a.underlyingPerShare();
        vm.mockCall(
            ACCOUNTANT, abi.encodeWithSignature("kHYPEToHYPE(uint256)", 1e18), abi.encode(rate * 10_001 / 10_000)
        );
        vault.reportYield(id);
        assertGt(vault.accruedYield(id), 0, "rate growth is yield");
        assertGt(vault.treasuryBalance(), 0, "the Yield Fee is taken at the source");
    }
}
