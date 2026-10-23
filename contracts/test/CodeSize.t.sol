// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// EIP-170: a chain refuses to deploy a contract whose runtime code is over 24,576 B (Hoodi refused the
/// 28,322 B PositionVaultOApp). Forge's EVM does not enforce it in tests, so this does. Every contract that is
/// deployed to a chain is listed here; add new ones. A contract that deploys another with `new` in its constructor
/// is checked through its own runtime code: the child's creation code only costs initcode (EIP-3860, 49,152 B).
/// Reads the build artifacts (`out/`), so it needs `fs_permissions` in foundry.toml.
contract CodeSizeTest is Test {
    uint256 constant EIP170_LIMIT = 24_576;
    uint256 constant INITCODE_LIMIT = 49_152;
    /// Room for a later fix to the vault.
    uint256 constant VAULT_TARGET = 23_500;

    function _check(string memory artifact) internal view returns (uint256 runtime) {
        runtime = vm.getDeployedCode(artifact).length;
        uint256 initcode = vm.getCode(artifact).length;
        require(runtime <= EIP170_LIMIT, string.concat(artifact, ": runtime code over the EIP-170 limit of 24576 B"));
        require(initcode <= INITCODE_LIMIT, string.concat(artifact, ": initcode over the EIP-3860 limit of 49152 B"));
    }

    function test_deployableContractsFitTheEvmLimits() public view {
        _check("PositionVault.sol:PositionVault");
        _check("PrizeModule.sol:PrizeModule");
        _check("SimLST.sol:SimLST");
        _check("StakeZap.sol:LidoZap");
        _check("StakeZap.sol:KinetiqZap");
        _check("WstETHRateAdapter.sol:WstETHRateAdapter");
        _check("KHypeRateAdapter.sol:KHypeRateAdapter");
    }

    function test_vaultKeepsHeadroom() public view {
        uint256 oapp = _check("PositionVaultOApp.sol:PositionVaultOApp");
        assertLe(oapp, VAULT_TARGET, "PositionVaultOApp runtime above the 23,500 B target");
    }
}
