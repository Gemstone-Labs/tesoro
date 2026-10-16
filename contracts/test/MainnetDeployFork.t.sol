// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {LidoZap, KinetiqZap} from "../src/StakeZap.sol";
import {DeployMainnetWstETH} from "../script/DeployMainnetWstETH.s.sol";
import {DeployMainnetKHype} from "../script/DeployMainnetKHype.s.sol";

/// Runs the real deploy scripts against mainnet state (nothing is broadcast), wires the peer as the owner would,
/// then opens a Position through the zap on the real LayerZero endpoint and checks the Yield Report size.
///   ETH_MAINNET_RPC=https://ethereum-rpc.publicnode.com HYPEREVM_MAINNET_RPC=https://rpc.hyperliquid.xyz/evm \
///     forge test --match-contract MainnetDeployFork
contract MainnetDeployForkTest is Test {
    uint32 constant SOLANA = 30168;
    bytes32 constant STORE = bytes32(uint256(0x60ae58df));
    address constant OWNER = address(0x2222);
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant KHYPE = 0xfD739d4e423301CE9385c1fb8850539D657C296D;
    address constant STAKING_MANAGER = 0x393D0B87Ed38fc779FD9611144aE649BA6082109;
    address alice = address(0xA11CE);

    function _fork(string memory env) internal returns (bool) {
        string memory rpc = vm.envOr(env, string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        vm.setEnv("VAULT_OWNER", vm.toString(OWNER));
        vm.setEnv("EVM_DEPLOYER_PRIVATE_KEY", vm.toString(uint256(0xBEEF)));
        return true;
    }

    function _vault(address deployed) internal returns (PositionVaultOApp v) {
        v = PositionVaultOApp(payable(deployed));
        vm.prank(OWNER);
        v.setPeer(SOLANA, STORE);
        assertEq(v.owner(), OWNER);
        assertEq(v.solanaEid(), SOLANA);
    }

    function test_ethereumScriptDeploysAVaultThatOpensThroughLidoZap() public {
        if (!_fork("ETH_MAINNET_RPC")) vm.skip(true, "ETH_MAINNET_RPC not set");
        DeployMainnetWstETH s = new DeployMainnetWstETH();
        uint64 n = vm.getNonce(vm.addr(0xBEEF));
        s.run();
        address vaultAddr = vm.computeCreateAddress(vm.addr(0xBEEF), n + 1); // the adapter is created first
        PositionVaultOApp v = _vault(vaultAddr);
        assertEq(address(v.lst()), WSTETH);
        LidoZap zap = new LidoZap(vaultAddr, WSTETH);
        vm.deal(alice, 5 ether);
        uint256 fee = v.quotePositionLocked();
        assertGt(fee, 0, "real LayerZero quote");
        vm.prank(alice);
        (uint64 id,) = zap.openWithNative{value: 1 ether + fee * 2}(1 ether, 0, 12);
        assertEq(v.getPosition(id).owner, alice);
        assertGt(v.quoteYieldAccrued(), 0);
    }

    function test_hyperEvmScriptDeploysAVaultThatOpensThroughKinetiqZap() public {
        if (!_fork("HYPEREVM_MAINNET_RPC")) vm.skip(true, "HYPEREVM_MAINNET_RPC not set");
        DeployMainnetKHype s = new DeployMainnetKHype();
        uint64 n = vm.getNonce(vm.addr(0xBEEF));
        s.run();
        address vaultAddr = vm.computeCreateAddress(vm.addr(0xBEEF), n + 1); // the adapter is created first
        PositionVaultOApp v = _vault(vaultAddr);
        assertEq(address(v.lst()), KHYPE);
        KinetiqZap zap = new KinetiqZap(vaultAddr, KHYPE, STAKING_MANAGER);
        vm.deal(alice, 50 ether);
        uint256 fee = v.quotePositionLocked();
        assertGt(fee, 0, "real LayerZero quote");
        uint256 stake = zap.minStake() + 1 ether;
        vm.prank(alice);
        (uint64 id,) = zap.openWithNative{value: stake + fee * 2}(stake, 0, 12);
        assertEq(v.getPosition(id).owner, alice);
        assertGt(v.quoteYieldAccrued(), 0);
    }
}
