// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {PositionVaultBase} from "../src/PositionVaultBase.sol";
import {IRateSource} from "../src/IRateSource.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {MainnetVaultBase} from "./MainnetVault.t.sol";

/// Founder rule D2 (2026-10-20): holders carry a slash. After a rate fall a Position cannot pay every face claim
/// Solana already credited (core keeps a high-water mark), so the vault pays every claim the same fraction of face
/// at the moment it pays, instead of first come first served. Design: economy-notes/slash-prorata.md.
///
/// Position of 10 shares opened at 1.2 (Principal 12). At 1.32 its yield is 1.2, reported (face 1.2). A slash to
/// 1.26 leaves 0.6 of backing for 1.2 of face: every claim is paid 50%.
contract SlashProRataTest is MainnetVaultBase {
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function _adapter(address token) internal override returns (IRateSource) {
        return new WstETHRateAdapter(token);
    }

    /// An open Position with 1.2 of reported face yield at 1.32, then slashed to 1.26.
    function _slashed() internal returns (uint64 id) {
        id = _open(10 ether);
        tok.setRate(1.32e18);
        (uint256 reported,,) = _report(id);
        assertApproxEqAbs(reported, 1.2 ether, 2);
        tok.setRate(1.26e18);
    }

    function _value(address who) internal view returns (uint256) {
        return tok.balanceOf(who) * 1.26e18 / 1e18;
    }

    function _vaultKey() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(vault))) << 96);
    }

    function _batch(uint64 batchId, uint8 kind, address to, uint64 id, uint128 units)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(6), lz.eid(), _vaultKey(), batchId, kind, bytes32(uint256(uint160(to))), uint8(1), id, units
        );
    }

    // ---------------------------------------------------------------- the rule

    function test_noSlashPaysFullFaceAndTheRatioIsOne() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        assertEq(vault.payoutRatio(id), 1e18);
        uint128 face = uint128(vault.payableYield(id));
        _recv(_pay(4, id, 1, bob, face));
        assertApproxEqAbs(tok.balanceOf(bob) * 1.32e18 / 1e18, face, 2);
        assertEq(vault.haircutUnits(id), 0);
        assertEq(vault.payoutRatio(id), 1e18);
    }

    function test_aSlashPaysEveryClaimTheSameFractionOfFace() public {
        uint64 id = _slashed();
        assertApproxEqAbs(vault.payoutRatio(id), 0.5e18, 1e6);
        _recv(_pay(4, id, 1, bob, 0.6 ether));
        assertApproxEqAbs(_value(bob), 0.3 ether, 4, "the first to be paid gets half, not all");
        assertApproxEqAbs(vault.payoutRatio(id), 0.5e18, 1e6, "the ratio is unchanged by a payment");
        _recv(_pay(4, id, 2, carol, 0.6 ether));
        assertApproxEqAbs(_value(carol), 0.3 ether, 4, "the second gets the same half, not nothing");
        assertApproxEqAbs(vault.haircutUnits(id), 0.6 ether, 8);
    }

    function test_deliveryOrderDoesNotChangeWhatEachHolderGets() public {
        uint64 id = _slashed();
        uint256 snap = vm.snapshotState();
        // order 1: small claim first
        _recv(_pay(4, id, 1, bob, 0.2 ether));
        _recv(_pay(4, id, 2, carol, 1.0 ether));
        uint256 bob1 = tok.balanceOf(bob);
        uint256 carol1 = tok.balanceOf(carol);
        vm.revertToState(snap);
        // order 2: big claim first
        _recv(_pay(4, id, 1, carol, 1.0 ether));
        _recv(_pay(4, id, 2, bob, 0.2 ether));
        assertApproxEqAbs(tok.balanceOf(bob), bob1, 4);
        assertApproxEqAbs(tok.balanceOf(carol), carol1, 4);
        assertApproxEqAbs(bob1 * 1.26e18 / 1e18, 0.1 ether, 4, "half of 0.2");
        assertApproxEqAbs(carol1 * 1.26e18 / 1e18, 0.5 ether, 4, "half of 1.0");
    }

    function test_theWholeSlashIsCarriedByTheHoldersAndNobodyElse() public {
        uint64 id = _slashed();
        uint64 other = _open(10 ether); // opens at 1.26
        _fund(2 ether);
        uint256 treasuryBefore = vault.treasuryBalance();
        uint256 treasurySharesBefore = vault.treasuryShares();
        uint256 otherHeld = vault.getPosition(other).heldShares;
        _recv(_pay(4, id, 1, bob, 0.6 ether));
        _recv(_pay(4, id, 2, carol, 0.6 ether));
        assertEq(vault.treasuryBalance(), treasuryBefore, "no Treasury money");
        assertEq(vault.treasuryShares(), treasurySharesBefore);
        assertEq(vault.poolOwedShares(), 0, "no Pool money");
        assertEq(vault.getPosition(other).heldShares, otherHeld, "no other Position's shares");
        assertGe(tok.balanceOf(address(vault)), vault.openHeldShares(), "open Positions stay fully backed");
        // the Position paid exactly its backing (0.6), not its face (1.2)
        assertApproxEqAbs(_value(bob) + _value(carol), 0.6 ether, 8);
    }

    function test_recoveryAfterASlashPaysTheRestInFull() public {
        uint64 id = _slashed();
        _recv(_pay(4, id, 1, bob, 0.6 ether)); // paid 50% at the bottom
        tok.setRate(1.32e18); // recovered
        assertEq(vault.payoutRatio(id), 1e18);
        _recv(_pay(4, id, 2, carol, 0.6 ether));
        assertApproxEqAbs(tok.balanceOf(carol) * 1.32e18 / 1e18, 0.6 ether, 4, "full face after recovery");
        assertLt(tok.balanceOf(bob) * 1.32e18 / 1e18, 0.5 ether, "who sold at the bottom keeps the haircut");
    }

    function test_theYieldFeeIsChargedOnceOnWhatIsReallyPaid() public {
        uint64 id = _slashed();
        // face 0.6 with the usual 20% fee and half of it to the Pool
        uint256 treasurySharesBefore = vault.treasuryShares();
        _recv(_payFee(id, 1, bob, 0.6 ether, 0.12 ether, 0.06 ether));
        // paid 0.3: fee 0.06, holder 0.24, pool 0.03
        assertApproxEqAbs(_value(bob), 0.24 ether, 6, "holder gets 80% of what was paid");
        assertApproxEqAbs((vault.treasuryShares() - treasurySharesBefore) * 1.26e18 / 1e18, 0.06 ether, 6);
        assertApproxEqAbs(vault.poolOwedShares() * 1.26e18 / 1e18, 0.03 ether, 6);
        assertApproxEqAbs(vault.getPosition(id).paidUnderlying, 0.3 ether, 6, "actual paid, not face");
    }

    function test_payingAboveTheFaceStillReverts() public {
        uint64 id = _slashed();
        bytes memory m = _pay(4, id, 1, bob, 1.3 ether);
        vm.prank(address(lz));
        vm.expectPartialRevert(PositionVaultBase.ExceedsAccruedYield.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
    }

    function test_aTotalDipWaitsInsteadOfBurningTheClaim() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _report(id);
        tok.setRate(1.1e18); // below the open rate: nothing backs the claims
        bytes memory m = _pay(4, id, 1, bob, 0.6 ether);
        vm.prank(address(lz));
        vm.expectPartialRevert(PositionVaultBase.ExceedsAccruedYield.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
        tok.setRate(1.32e18);
        _recv(m);
        assertApproxEqAbs(tok.balanceOf(bob) * 1.32e18 / 1e18, 0.6 ether, 4);
    }

    // ---------------------------------------------------------------- unlocked Position

    function test_anUnlockedPositionPaysItsHoldersTheSameShareOfItsOwedShares() public {
        uint64 id = _slashed();
        _recv(_unlock(id, 1)); // frozen at the slashed 0.6, face still 1.2
        uint256 owed = vault.owedSharesOf(id);
        assertApproxEqAbs(owed * 1.26e18 / 1e18, 0.6 ether, 4);
        _recv(_pay(4, id, 2, bob, 0.3 ether)); // a quarter of the face
        assertApproxEqAbs(tok.balanceOf(bob), owed / 4, 2);
        _recv(_pay(4, id, 3, carol, 0.9 ether)); // the rest
        assertApproxEqAbs(tok.balanceOf(carol), owed * 3 / 4, 2);
        assertLe(vault.owedSharesOf(id), 2, "nothing left locked");
        assertGe(vault.treasuryShares(), vault.owedShares());
    }

    /// The haircut already paid is not re-credited: after a recovery the Position owes its holders only the face that
    /// is left (yield above the old mark), and the surplus is the Treasury's leftover, not shares locked for nobody.
    function test_unlockAfterAHaircutLocksOnlyTheFaceThatIsLeft() public {
        uint64 id = _slashed();
        _recv(_pay(4, id, 1, bob, 1.2 ether)); // all the reported face, paid at 50%
        tok.setRate(1.4e18); // recovery above the old mark; nothing new reported
        uint256 left = vault.accruedYield(id) - 1.2 ether; // face extinguished is 1.2
        uint256 treasuryBefore = vault.treasuryShares();
        _recv(_unlock(id, 2));
        assertApproxEqAbs(vault.owedSharesOf(id) * 1.4e18 / 1e18, left, 8, "only the face that is left is owed");
        assertGt(vault.treasuryShares(), treasuryBefore, "the surplus is the Treasury's leftover");
        assertGe(vault.treasuryShares(), vault.owedShares());
    }

    // ---------------------------------------------------------------- batches

    function test_aBatchAndAPayYieldShareTheSlashAndAcknowledgeFace() public {
        uint64 id = _slashed();
        vm.deal(address(vault), 1 ether); // the vault pays the acknowledgement's message fee
        _recv(_batch(1, 0, bob, id, 0.6 ether));
        assertApproxEqAbs(_value(bob), 0.3 ether, 4, "the batch entry takes the same half");
        // the acknowledgement carries face (0.6): the claim is extinguished
        bytes memory ack = lz.lastMessage();
        assertEq(uint8(ack[0]), 8);
        assertEq(uint128(bytes16(_slice(ack, 46, 16))), 0.6 ether);
        _recv(_pay(4, id, 1, carol, 0.6 ether));
        assertApproxEqAbs(_value(carol), 0.3 ether, 4);
    }

    /// The Leaderboard Pool is a holder like any other: its fee-class Gemas pay the same half into the escrow.
    function test_thePoolCarriesItsShareOfTheSlashInTheEscrow() public {
        uint64 id = _slashed();
        vm.deal(address(vault), 1 ether);
        _recv(_batch(1, 2, address(0), id, 0.6 ether));
        assertApproxEqAbs(vault.escrowedUnits(), 0.3 ether, 4, "the escrow holds what was paid, not face");
        assertEq(uint128(bytes16(_slice(lz.lastMessage(), 46, 16))), 0.6 ether, "the acknowledgement is face");
        _recv(_pay(4, id, 1, carol, 0.6 ether));
        assertApproxEqAbs(_value(carol), 0.3 ether, 4, "a holder gets the same fraction as the Pool");
    }

    function test_redeliveringACompletedBatchNeverDividesByZero() public {
        uint64 id = _slashed();
        bytes memory b = _batch(1, 0, bob, id, 1.2 ether); // the whole face
        _recv(b);
        assertEq(vault.payoutRatio(id), 1e18, "no claims left");
        _recv(b); // again: x = 0, N = 0
        assertApproxEqAbs(_value(bob), 0.6 ether, 8);
    }

    // ---------------------------------------------------------------- fuzz

    /// Any slash depth, three holders, any delivery order: each is paid the same fraction (within dust) and the Position
    /// never pays more than it holds.
    function testFuzz_everyOrderPaysTheSameFraction(uint256 slash, uint256 f1, uint256 f2, uint8 order) public {
        slash = bound(slash, 1.21e18, 1.31e18);
        f1 = bound(f1, 0.05 ether, 0.5 ether);
        f2 = bound(f2, 0.05 ether, 0.5 ether);
        uint256 f3 = 1.2 ether - f1 - f2;
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _report(id);
        tok.setRate(slash);
        uint256 backing = vault.payableYield(id);
        uint256[3] memory face = [f1, f2, f3];
        address[3] memory who = [bob, carol, redeemer];
        uint256[3] memory idx = order % 2 == 0 ? [uint256(0), 1, 2] : [uint256(2), 0, 1];
        uint64 s = 1;
        for (uint256 k; k < 3; k++) {
            uint256 i = idx[k];
            _recv(_pay(4, id, s++, who[i], uint128(face[i])));
        }
        uint256 paid;
        for (uint256 i; i < 3; i++) {
            uint256 v = tok.balanceOf(who[i]) * slash / 1e18;
            paid += v;
            assertApproxEqAbs(v * 1e18 / face[i], backing * 1e18 / 1.2 ether, 2e10, "same fraction of face");
        }
        assertLe(paid, backing + 8, "never more than the Position holds");
        assertGe(tok.balanceOf(address(vault)), vault.openHeldShares());
    }
}
