// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";

/// Usage (key comes from the environment, never from the command line or repo):
///   set -a; source ~/.config/tesoro/evm-deployer.env; set +a
///   forge script script/Deploy.s.sol --rpc-url $HOODI_RPC_URL --broadcast
///
/// Ethereum Hoodi (560048): SimLST + vault on it, plus a vault on real Lido wstETH via the rate adapter.
/// HyperEVM testnet (998): SimLST + vault only (no wstETH). Prepared, not deployed (no HYPE for gas).
///   Contracts larger than the 3M small-block gas limit need big blocks enabled first
///   ({"type":"evmUserModify","usingBigBlocks":true}).
/// MockEndpoint stands in for LayerZero until the OApp lands.
contract Deploy is Script {
    uint256 constant HOODI = 560048;
    uint256 constant HYPEREVM_TESTNET = 998;

    // LayerZero endpoint ids double as the Tesoro chain id in payloads.
    uint32 constant EID_HOODI = 40449;
    uint32 constant EID_HYPEREVM_TESTNET = 40362;

    address constant HOODI_WSTETH = 0x7E99eE3C66636DE415D2d7C880938F2f40f94De4;

    function run() external {
        uint32 chainTag;
        bool hasWstETH;
        if (block.chainid == HOODI) {
            chainTag = EID_HOODI;
            hasWstETH = true;
        } else if (block.chainid == HYPEREVM_TESTNET) {
            chainTag = EID_HYPEREVM_TESTNET;
        } else {
            revert("unsupported chain");
        }

        uint256 reserveEth = vm.envOr("SIMLST_RESERVE_WEI", uint256(0.05 ether));

        uint256 pk = vm.envUint("EVM_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        SimLST sim = new SimLST(deployer, hasWstETH ? "Simulated Staked ETH" : "Simulated Staked HYPE", hasWstETH ? "simETH" : "simHYPE");
        MockEndpoint endpoint = new MockEndpoint();
        PositionVault simVault = new PositionVault(address(sim), address(sim), address(endpoint), chainTag);
        if (reserveEth > 0) {
            (bool ok,) = address(sim).call{value: reserveEth}("");
            require(ok, "reserve funding failed");
        }

        console.log("chainId", block.chainid);
        console.log("SimLST", address(sim));
        console.log("MockEndpoint", address(endpoint));
        console.log("PositionVault (SimLST)", address(simVault));

        if (hasWstETH) {
            WstETHRateAdapter adapter = new WstETHRateAdapter(HOODI_WSTETH);
            uint256 rate = adapter.underlyingPerShare();
            require(rate >= 1e18, "wstETH rate sanity");
            PositionVault wstVault = new PositionVault(HOODI_WSTETH, address(adapter), address(endpoint), chainTag);
            console.log("WstETHRateAdapter", address(adapter));
            console.log("PositionVault (wstETH)", address(wstVault));
            console.log("wstETH stEthPerToken", rate);
        }
        vm.stopBroadcast();
    }
}
