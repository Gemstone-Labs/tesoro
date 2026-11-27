// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {IRateSource} from "../src/IRateSource.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {MainnetVaultBase} from "./MainnetVault.t.sol";

/// The Solana to EVM pathway grants every inbound message the same `receiveGas` and the executor refuses a message
/// above `maxMessageBytes` (both in bridge/evm-receive.json, which scripts/lz-mainnet.ts wires). Each delivery here
/// is its own transaction (`isolate = true`), so storage is cold as on the chain. The mock endpoint's ack send is
/// cheaper than the real endpoint's, hence the 15% margin.
abstract contract ReceiveGasBase is MainnetVaultBase {
    string constant CONFIG = "../bridge/evm-receive.json";
    uint256 constant MAX_ENTRIES = 8;
    uint8 constant KIND_WALLET = 0;
    uint8 constant KIND_LEADERBOARD = 2;

    address fresh = address(0xF001);
    uint64 batchId;

    function _receiveGas() internal view returns (uint256) {
        return vm.parseJsonUint(vm.readFile(CONFIG), ".receiveGas");
    }

    function _maxMessageBytes() internal view returns (uint256) {
        return vm.parseJsonUint(vm.readFile(CONFIG), ".maxMessageBytes");
    }

    function _vaultKey() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(vault))) << 96);
    }

    function _deliver(string memory kind, uint256 entries, bytes memory m) internal returns (uint256 used) {
        vm.prank(address(lz));
        uint256 g = gasleft();
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
        used = g - gasleft();
        console.log(string.concat("gas ", kind, " x", vm.toString(entries)), used);
        assertLe(
            used,
            _receiveGas() * 85 / 100,
            string.concat(kind, " x", vm.toString(entries), " needs more than 85% of the receive gas")
        );
    }

    function _batchMsg(uint8 kind, address to, uint64[] memory ids, uint128[] memory units)
        internal
        returns (bytes memory m)
    {
        m = abi.encodePacked(
            uint8(6), lz.eid(), _vaultKey(), ++batchId, kind, bytes32(uint256(uint160(to))), uint8(ids.length)
        );
        for (uint256 i; i < ids.length; i++) {
            m = abi.encodePacked(m, ids[i], units[i]);
        }
    }

    /// `n` open Positions that each earned yield; half of it is asked for.
    function _earners(uint256 n) internal returns (uint64[] memory ids, uint128[] memory units) {
        tok.mint(alice, 200 ether);
        ids = new uint64[](n);
        units = new uint128[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = _open(1 ether);
        }
        tok.setRate(tok.stEthPerToken() * 11 / 10);
        for (uint256 i; i < n; i++) {
            units[i] = uint128(vault.payableYield(ids[i]) / 2);
        }
        vm.deal(address(vault), 1 ether);
    }

    function _prizeMsg(uint64 payoutId, address to, uint128 shares, uint128 deliveryFee)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(13),
            lz.eid(),
            _vaultKey(),
            payoutId,
            bytes32(uint256(uint160(address(tok)))),
            bytes32(uint256(0x9a17e)),
            bytes32(uint256(uint160(to))),
            shares,
            deliveryFee
        );
    }

    function test_unlockFitsTheReceiveGas() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _deliver("Unlock", 1, _unlock(id, 1));
    }

    function test_payYieldFitsTheReceiveGas() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(a) / 2);
        _deliver("PayYield fee+pool, new recipient", 1, _payFee(a, 1, fresh, amt, amt / 10, amt / 20));
        vault.setDelivery(address(0xDE11), 1 ether);
        uint128 amtB = uint128(vault.payableYield(b) / 2);
        bytes memory m = abi.encodePacked(
            uint8(11),
            lz.eid(),
            _key(b),
            uint64(1),
            bytes32(uint256(uint160(address(0xF002)))),
            amtB,
            amtB / 10,
            amtB / 20,
            uint128(0.001 ether)
        );
        _deliver("PayYield fee+pool+Delivery Fee, new recipient", 1, m);
    }

    function test_payInstantFitsTheReceiveGas() public {
        uint64 id = _open(10 ether);
        _fund(20 ether);
        tok.setRate(1.32e18);
        vault.setDelivery(address(0xDE11), 1 ether);
        bytes memory m = abi.encodePacked(
            uint8(12),
            lz.eid(),
            _key(id),
            uint64(1),
            bytes32(uint256(uint160(fresh))),
            uint128(vault.treasuryBalance() / 10),
            uint128(0.001 ether)
        );
        _deliver("PayInstant Delivery Fee, new recipient", 1, m);
    }

    function test_payPrizeFitsTheReceiveGas() public {
        (uint64[] memory ids, uint128[] memory units) = _earners(4);
        _recv(_batchMsg(KIND_LEADERBOARD, address(0), ids, units));
        vault.setDelivery(address(0xDE11), 1 ether);
        _deliver(
            "PayPrize Delivery Fee, new recipient",
            1,
            _prizeMsg(1, fresh, uint128(vault.escrowShares() / 4), 0.001 ether)
        );
    }

    function test_walletBatchesFitTheReceiveGas() public {
        _batches(KIND_WALLET, "CashInBatch wallet");
    }

    function test_escrowBatchesFitTheReceiveGas() public {
        _batches(KIND_LEADERBOARD, "CashInBatch escrow (first escrow write)");
    }

    /// Each entry count runs on a fresh vault state, so the escrow's first write is included.
    function _batches(uint8 kind, string memory name) internal {
        for (uint256 n = 1; n <= MAX_ENTRIES; n++) {
            uint256 snap = vm.snapshotState();
            (uint64[] memory ids, uint128[] memory units) = _earners(n);
            _deliver(name, n, _batchMsg(kind, kind == KIND_WALLET ? fresh : address(0), ids, units));
            assertTrue(vm.revertToState(snap));
        }
    }

    /// The acknowledgement of a full batch is the largest message the vault sends; every size stays under the cap.
    function test_everyOutboundMessageFitsTheExecutorCap() public {
        uint256 cap = _maxMessageBytes();
        uint64 id = _open(10 ether);
        assertLe(lz.lastMessage().length, cap, "PositionLocked");
        tok.setRate(1.32e18);
        _report(id);
        assertLe(lz.lastMessage().length, cap, "YieldAccrued");
        (uint64[] memory ids, uint128[] memory units) = _earners(MAX_ENTRIES);
        _recv(_batchMsg(KIND_WALLET, fresh, ids, units));
        assertEq(lz.lastMessage().length, 45 + 1 + 16 * MAX_ENTRIES + 32, "8-entry batch result");
        assertLe(lz.lastMessage().length, cap, "8-entry batch result");
        _recv(_batchMsg(KIND_LEADERBOARD, address(0), ids, units));
        _recv(_prizeMsg(1, fresh, uint128(vault.escrowShares() / 4), 0));
        assertLe(lz.lastMessage().length, cap, "PayPrize result");
    }
}

contract ReceiveGasWstETHTest is ReceiveGasBase {
    function _adapter(address token) internal override returns (IRateSource) {
        return new WstETHRateAdapter(token);
    }
}

contract ReceiveGasKHypeTest is ReceiveGasBase {
    function _adapter(address token) internal override returns (IRateSource) {
        return new KHypeRateAdapter(token);
    }
}
