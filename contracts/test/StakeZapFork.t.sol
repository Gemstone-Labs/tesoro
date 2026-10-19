// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {LidoZap, KinetiqZap} from "../src/StakeZap.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";

interface IBal {
    function balanceOf(address) external view returns (uint256);
}

/// Plain ETH / HYPE through the real providers. Skipped unless the RPC is set.
///   ETH_MAINNET_RPC=<url> forge test --match-contract LidoZapForkTest
contract LidoZapForkTest is Test {
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function test_ethBecomesWstETHAndOpens() public {
        if (!forked) vm.skip(true, "ETH_MAINNET_RPC not set");
        WstETHRateAdapter a = new WstETHRateAdapter(WSTETH);
        PositionVault vault = new PositionVault(WSTETH, address(a), address(new MockEndpoint()), 30101, address(0));
        LidoZap zap = new LidoZap(address(vault), WSTETH);
        address alice = address(0xA11CE);
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        (uint64 id, uint256 got) = zap.openWithNative{value: 2 ether}(2 ether, 0, 12);
        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(IBal(WSTETH).balanceOf(address(vault)), got);
        assertApproxEqAbs(p.principalUnderlying, 2 ether, 10, "Principal is the ETH staked, to wei rounding");
        assertEq(IBal(WSTETH).balanceOf(address(zap)), 0);
    }
}

/// ///   HYPEREVM_MAINNET_RPC=https://rpc.hyperliquid.xyz/evm forge test --match-contract KinetiqZapForkTest
contract KinetiqZapForkTest is Test {
    address constant KHYPE = 0xfD739d4e423301CE9385c1fb8850539D657C296D;
    address constant ACCOUNTANT = 0x9209648Ec9D448EF57116B73A2f081835643dc7A;
    address constant STAKING_MANAGER = 0x393D0B87Ed38fc779FD9611144aE649BA6082109;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("HYPEREVM_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function _zap() internal returns (PositionVault vault, KinetiqZap zap) {
        KHypeRateAdapter a = new KHypeRateAdapter(ACCOUNTANT);
        vault = new PositionVault(KHYPE, address(a), address(new MockEndpoint()), 30367, address(0));
        zap = new KinetiqZap(address(vault), KHYPE, STAKING_MANAGER);
    }

    function test_hypeBecomesKHypeAndOpens() public {
        if (!forked) vm.skip(true, "HYPEREVM_MAINNET_RPC not set");
        (PositionVault vault, KinetiqZap zap) = _zap();
        address alice = address(0xA11CE);
        vm.deal(alice, 50 ether);
        uint256 min = zap.minStake();
        assertGt(min, 0);
        vm.prank(alice);
        (uint64 id, uint256 got) = zap.openWithNative{value: min + 1 ether}(min + 1 ether, 0, 12);
        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(IBal(KHYPE).balanceOf(address(vault)), got);
        assertApproxEqRel(p.principalUnderlying, min + 1 ether, 1e12, "Principal is the HYPE staked");
        assertEq(IBal(KHYPE).balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
    }

    function test_belowKinetiqMinimumRevertsAndKeepsTheCoin() public {
        if (!forked) vm.skip(true, "HYPEREVM_MAINNET_RPC not set");
        (PositionVault vault, KinetiqZap zap) = _zap();
        address alice = address(0xA11CE);
        vm.deal(alice, 50 ether);
        uint256 min = zap.minStake();
        vm.prank(alice);
        vm.expectRevert();
        zap.openWithNative{value: min - 1}(min - 1, 0, 12);
        assertEq(alice.balance, 50 ether);
        assertEq(vault.nextPositionId(), 0);
    }
}
