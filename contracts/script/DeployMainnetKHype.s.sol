// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";

/// HyperEVM mainnet kHYPE vault (ticket 15). NOT run by agents: the orchestrator deploys it.
///   forge script script/DeployMainnetKHype.s.sol --rpc-url hyperevm --broadcast --slow   (EVM_DEPLOYER_PRIVATE_KEY, VAULT_OWNER from env)
/// The vault needs ~3.37M gas, above HyperEVM's small-block limit: enable big blocks for the deployer first
/// (see docs/cross-chain.md), deploy, then switch them off.
/// Afterwards: setPeer(30168, <tesoro_bridge Store PDA>) from the owner, wire the pathway (bridge/scripts/lz.ts),
/// register the vault with `set_peer_config` (eid 30367, 18 decimals).
contract DeployMainnetKHype is Script {
    uint256 constant HYPEREVM = 999;
    /// LayerZero V2 EndpointV2 on HyperEVM mainnet and the eids (metadata.layerzero-api.com, checked 2026-10-15).
    address constant LZ_ENDPOINT = 0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9;
    uint32 constant EID_HYPEREVM = 30367;
    uint32 constant EID_SOLANA = 30168;
    /// Kinetiq kHYPE and StakingAccountant (kinetiq.xyz/docs/contracts-and-audits; both read on-chain 2026-10-15).
    address constant KHYPE = 0xfD739d4e423301CE9385c1fb8850539D657C296D;
    address constant ACCOUNTANT = 0x9209648Ec9D448EF57116B73A2f081835643dc7A;

    function run() external {
        require(block.chainid == HYPEREVM, "HyperEVM mainnet only");
        address delegate = vm.envAddress("VAULT_OWNER"); // the multisig: owner and LayerZero delegate
        uint256 pk = vm.envUint("EVM_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        KHypeRateAdapter adapter = new KHypeRateAdapter(ACCOUNTANT);
        require(adapter.underlyingPerShare() >= 1e18, "kHYPE rate sanity");
        PositionVaultOApp vault = new PositionVaultOApp(
            KHYPE, address(adapter), LZ_ENDPOINT, EID_HYPEREVM, EID_SOLANA, delegate, address(0)
        );
        vm.stopBroadcast();
        console.log("KHypeRateAdapter", address(adapter));
        console.log("PositionVaultOApp (kHYPE)", address(vault));
    }
}
