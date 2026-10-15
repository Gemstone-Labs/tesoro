// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";

interface IStETH {
    function submit(address referral) external payable returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IWstETHWrap {
    function wrap(uint256) external returns (uint256);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Optional: runs against Ethereum mainnet state, skipped unless ETH_MAINNET_RPC is set.
///   ETH_MAINNET_RPC=<url> forge test --match-contract WstETHMainnetForkTest
contract WstETHMainnetForkTest is Test {
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function test_adapterReadsRealStEthPerToken() public {
        if (!forked) vm.skip(true, "ETH_MAINNET_RPC not set");
        WstETHRateAdapter a = new WstETHRateAdapter(WSTETH);
        uint256 r = a.underlyingPerShare();
        assertGt(r, 1e18, "wstETH is worth more than 1 stETH");
        assertLt(r, 2e18, "and less than 2");
    }

    function test_vaultYieldFollowsTheRealRate() public {
        if (!forked) vm.skip(true, "ETH_MAINNET_RPC not set");
        WstETHRateAdapter a = new WstETHRateAdapter(WSTETH);
        MockEndpoint ep = new MockEndpoint();
        PositionVault vault = new PositionVault(WSTETH, address(a), address(ep), 30101, address(0));
        address alice = address(0xA11CE);
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        IStETH(STETH).submit{value: 2 ether}(address(0));
        IStETH(STETH).approve(WSTETH, type(uint256).max);
        uint256 shares = IWstETHWrap(WSTETH).wrap(1 ether);
        IWstETHWrap(WSTETH).approve(address(vault), type(uint256).max);
        uint64 id = vault.openPosition(shares, 12);
        vm.stopPrank();
        assertEq(vault.accruedYield(id), 0);
        // Lido credits rewards once a day through its oracle report; model one as +0.01% on the real rate.
        uint256 rate = a.underlyingPerShare();
        vm.mockCall(WSTETH, abi.encodeWithSignature("stEthPerToken()"), abi.encode(rate * 10_001 / 10_000));
        vault.reportYield(id);
        assertGt(vault.accruedYield(id), 0, "rate growth is yield");
        assertGt(vault.treasuryIn(), 0, "the Yield Fee is taken at the source");
    }
}
