// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";

/// Ethereum mainnet wstETH vault (ticket 14). NOT run by agents: the orchestrator deploys it.
///   forge script script/DeployMainnetWstETH.s.sol --rpc-url ethereum --broadcast   (key and DELEGATE from env)
/// Afterwards: setPeer(30168, <tesoro_bridge Store PDA>) from the owner, wire the pathway (bridge/scripts/lz.ts),
/// register the vault with `set_peer_config` (eid 30101, 18 decimals).
contract DeployMainnetWstETH is Script {
    uint256 constant ETHEREUM = 1;
    /// LayerZero V2 EndpointV2 on Ethereum mainnet and the eids (metadata.layerzero-api.com, checked 2026-10-15).
    address constant LZ_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    uint32 constant EID_ETHEREUM = 30101;
    uint32 constant EID_SOLANA = 30168;
    /// Lido wstETH (docs.lido.fi/deployed-contracts).
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    function run() external {
        require(block.chainid == ETHEREUM, "Ethereum mainnet only");
        address delegate = vm.envAddress("VAULT_OWNER"); // the multisig: owner and LayerZero delegate
        uint256 pk = vm.envUint("EVM_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        WstETHRateAdapter adapter = new WstETHRateAdapter(WSTETH);
        require(adapter.underlyingPerShare() >= 1e18, "wstETH rate sanity");
        PositionVaultOApp vault = new PositionVaultOApp(
            WSTETH, address(adapter), LZ_ENDPOINT, EID_ETHEREUM, EID_SOLANA, delegate, address(0)
        );
        vm.stopBroadcast();
        console.log("WstETHRateAdapter", address(adapter));
        console.log("PositionVaultOApp (wstETH)", address(vault));
    }
}
