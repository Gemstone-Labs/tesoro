// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {MockLzEndpoint} from "./PositionVaultOApp.t.sol";
import {RateToken} from "./MainnetVault.t.sol";

/// Prize escrow, cash-in batches and PayPrize (economy upgrade, ticket 17) over the real wire format
/// (bridge/economy-notes bridge-messages.md): the vault is a `PositionVaultOApp`, messages are the packed bytes
/// tesoro_bridge sends, answers are read from the endpoint. The same tests run on a real-LST vault and a SimLST vault.
abstract contract EscrowBase is Test {
    uint32 constant SOLANA = 30168;
    bytes32 constant STORE = bytes32(uint256(0x5702E));
    MockLzEndpoint lz;
    PositionVaultOApp vault;
    address alice = address(0xA11CE);
    address platform = address(0xFEE1);
    address winner = address(0x1111);

    // ---- mode hooks
    function _setUpVault() internal virtual;
    function _token() internal view virtual returns (address);
    function _balance(address who) internal view virtual returns (uint256);
    /// @dev Makes every open Position earn yield (rate rise on a real LST, time on a SimLST).
    function _earn() internal virtual;
    function _isReal() internal pure virtual returns (bool);

    receive() external payable {}

    function setUp() public virtual {
        lz = new MockLzEndpoint();
        vm.deal(address(this), 10 ether);
        vm.deal(alice, 10 ether);
        _setUpVault();
        vault.setPeer(SOLANA, STORE);
        vm.deal(address(vault), 1 ether); // pays the LayerZero fee of results
    }

    // ---- wire helpers
    function _vaultKey() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(vault))) << 96);
    }

    function _key(uint64 id) internal view returns (bytes32) {
        return bytes32((uint256(uint160(address(vault))) << 96) | (uint256(id) << 32));
    }

    function _recv(bytes memory m) internal {
        vm.prank(address(lz));
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
    }

    function _batch(uint64 batchId, uint8 kind, address to, uint64[] memory ids, uint128[] memory units)
        internal
        view
        returns (bytes memory m)
    {
        m = abi.encodePacked(
            uint8(6), lz.eid(), _vaultKey(), batchId, kind, bytes32(uint256(uint160(to))), uint8(ids.length)
        );
        for (uint256 i; i < ids.length; i++) {
            m = abi.encodePacked(m, ids[i], units[i]);
        }
    }

    /// A holder cash-out that takes a Yield Fee: half of the payable yield, 20% of that as fee, half the fee to the Pool.
    function _cashOut(uint64 id, uint64 seq) internal returns (uint256 fee, uint256 pool) {
        uint128 amt = uint128(vault.payableYield(id) / 2);
        fee = amt / 5;
        pool = fee / 2;
        _recv(
            abi.encodePacked(
                uint8(4),
                lz.eid(),
                _key(id),
                seq,
                bytes32(uint256(uint160(address(0x2222)))),
                amt,
                uint128(fee),
                uint128(pool)
            )
        );
    }

    function _one(uint64 id, uint128 units) internal pure returns (uint64[] memory ids, uint128[] memory us) {
        ids = new uint64[](1);
        us = new uint128[](1);
        ids[0] = id;
        us[0] = units;
    }

    function _prize(uint64 payoutId, address asset, address to, uint128 shares) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(7),
            lz.eid(),
            _vaultKey(),
            payoutId,
            bytes32(uint256(uint160(asset))),
            bytes32(uint256(0x9a17e)),
            bytes32(uint256(uint160(to))),
            shares
        );
    }

    function _u128At(bytes memory b, uint256 at) internal pure returns (uint128 v) {
        for (uint256 i; i < 16; i++) {
            v = (v << 8) | uint8(b[at + i]);
        }
    }

    /// The last result: (paid[], escrowedShares, escrowedUnits) of a BatchResult.
    function _batchResult(uint64 batchId, uint256 n)
        internal
        view
        returns (uint128[] memory paid, uint128 escShares, uint128 escUnits)
    {
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 45 + 1 + 16 * n + 32, "BatchResult length");
        assertEq(uint8(m[0]), 8, "BatchResult type");
        assertEq(bytes32(_slice(m, 5, 32)), _vaultKey(), "route key");
        assertEq(uint64(bytes8(_slice(m, 37, 8))), batchId, "batch id");
        assertEq(uint8(m[45]), n);
        paid = new uint128[](n);
        for (uint256 i; i < n; i++) {
            paid[i] = _u128At(m, 46 + 16 * i);
        }
        escShares = _u128At(m, 46 + 16 * n);
        escUnits = _u128At(m, 46 + 16 * n + 16);
    }

    function _prizeResult(uint64 payoutId) internal view returns (uint8 status, uint128 shares) {
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 62, "PayPrizeResult length");
        assertEq(uint8(m[0]), 9);
        assertEq(bytes32(_slice(m, 5, 32)), _vaultKey());
        assertEq(uint64(bytes8(_slice(m, 37, 8))), payoutId);
        status = uint8(m[45]);
        shares = _u128At(m, 46);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition{value: 0.0002 ether}(amt, 12);
    }

    function _unlock(uint64 id, uint64 seq) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(3), lz.eid(), _key(id), seq, uint128(0));
    }

    // ---- escrow funding from batches

    function test_leaderboardBatchMovesYieldIntoTheEscrowNotAWallet() public {
        uint64 id = _open(10 ether);
        _earn();
        uint256 want = vault.payableYield(id) / 2;
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(want));
        uint256 sendsBefore = lz.sends();
        _recv(_batch(1, 2, address(0), ids, us));

        assertEq(vault.getPosition(id).paidUnderlying, want);
        assertGt(vault.escrowShares(), 0);
        assertEq(vault.escrowedShares(), vault.escrowShares());
        assertEq(vault.escrowedUnits(), want, "units = what each share was worth on arrival");
        assertEq(lz.sends(), sendsBefore + 1, "one BatchResult");
        (uint128[] memory paid, uint128 es, uint128 eu) = _batchResult(1, 1);
        assertEq(paid[0], want);
        assertEq(es, vault.escrowedShares());
        assertEq(eu, vault.escrowedUnits());
        assertEq(_balance(platform), 0);
    }

    function test_platformAndStudioBatchesPayTheRecipientAndLeaveTheEscrowAlone() public {
        uint64 id = _open(10 ether);
        _earn();
        uint256 want = vault.payableYield(id) / 3;
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(want));
        _recv(_batch(1, 0, platform, ids, us));
        assertGt(_balance(platform), 0, "shares went to the recipient");
        assertEq(vault.escrowShares(), 0);
        assertEq(vault.escrowedUnits(), 0);
        (uint128[] memory paid,,) = _batchResult(1, 1);
        assertEq(paid[0], want);
        _recv(_batch(2, 1, winner, ids, us));
        assertGt(_balance(winner), 0);
    }

    function test_aBatchReservesAndPaysEveryNamedPosition() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(5 ether);
        _earn();
        uint64[] memory ids = new uint64[](2);
        uint128[] memory us = new uint128[](2);
        ids[0] = a;
        ids[1] = b;
        us[0] = uint128(vault.payableYield(a) / 2);
        us[1] = uint128(vault.payableYield(b) / 2);
        _recv(_batch(7, 2, address(0), ids, us));
        (uint128[] memory paid,,) = _batchResult(7, 2);
        assertEq(paid[0], us[0]);
        assertEq(paid[1], us[1]);
        assertEq(vault.escrowedUnits(), uint256(us[0]) + us[1]);
    }

    function test_aShortBatchPaysWhatItCanWithoutRevertingAndTheResendFinishesIt() public {
        uint64 id = _open(10 ether);
        _earn();
        uint256 canNow = vault.payableYield(id);
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(canNow * 2));
        _recv(_batch(1, 2, address(0), ids, us)); // no revert
        (uint128[] memory paid,,) = _batchResult(1, 1);
        assertEq(paid[0], canNow, "paid what the Position could pay");
        assertEq(vault.reservedUnits(id), canNow, "the unpaid rest is held back for this batch");

        _earn(); // more yield lands
        _recv(_batch(1, 2, address(0), ids, us)); // Solana resends the same bytes
        (paid,,) = _batchResult(1, 1);
        assertGt(paid[0], canNow, "the resend paid more");
        assertLe(paid[0], canNow * 2, "never more than requested");

        // once fully paid, the same bytes again pay nothing and are answered again
        for (uint256 i; i < 6; i++) {
            _earn();
            _recv(_batch(1, 2, address(0), ids, us));
        }
        (paid,,) = _batchResult(1, 1);
        assertEq(paid[0], canNow * 2, "complete");
        assertEq(vault.reservedUnits(id), 0, "reservation released");
        uint256 sends = lz.sends();
        uint256 escrow = vault.escrowedUnits();
        _recv(_batch(1, 2, address(0), ids, us));
        assertEq(vault.escrowedUnits(), escrow, "a delivery after completion pays nothing");
        assertEq(lz.sends(), sends + 1, "but the acknowledgement is regenerated");
    }

    function test_redeliveryOfAPaidBatchNeverPaysTwice() public {
        uint64 id = _open(10 ether);
        _earn();
        uint256 want = vault.payableYield(id) / 2;
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(want));
        bytes memory m = _batch(1, 2, address(0), ids, us);
        _recv(m);
        uint256 escrow = vault.escrowShares();
        uint256 paid0 = vault.getPosition(id).paidUnderlying;
        _recv(m);
        _recv(m);
        assertEq(vault.escrowShares(), escrow);
        assertEq(vault.getPosition(id).paidUnderlying, paid0);
    }

    function test_aPendingBatchReservesYieldAgainstOtherPayYield() public {
        uint64 id = _open(10 ether);
        _earn();
        uint256 canNow = vault.payableYield(id);
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(canNow * 2));
        _recv(_batch(1, 2, address(0), ids, us)); // pays canNow, holds canNow back
        _earn(); // yield lands after
        uint256 landed = vault.payableYield(id);
        assertGt(landed, 0);
        // a holder tries to take the newly landed yield: the pending batch comes first
        bytes memory pay = abi.encodePacked(
            uint8(4),
            lz.eid(),
            _key(id),
            uint64(1),
            bytes32(uint256(uint160(winner))),
            uint128(landed),
            uint128(0),
            uint128(0)
        );
        vm.prank(address(lz));
        vm.expectPartialRevert(PositionVault.ExceedsAccruedYield.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), pay, address(0), "");
        // the batch resend takes it (all of it up to what it still asked for)
        _recv(_batch(1, 2, address(0), ids, us));
        (uint128[] memory paid,,) = _batchResult(1, 1);
        assertGt(paid[0], canNow);
    }

    function test_aBatchContentMismatchIsIgnored() public {
        uint64 id = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 4));
        _recv(_batch(1, 2, address(0), ids, us));
        uint256 escrow = vault.escrowedUnits();
        us[0] *= 2;
        _recv(_batch(1, 2, address(0), ids, us)); // same id, other amount
        assertEq(vault.escrowedUnits(), escrow);
    }

    function test_anUnknownPositionPaysZeroAndDoesNotRevert() public {
        uint64 id = _open(10 ether);
        _earn();
        uint64[] memory ids = new uint64[](2);
        uint128[] memory us = new uint128[](2);
        ids[0] = 99;
        us[0] = 5;
        ids[1] = id;
        us[1] = uint128(vault.payableYield(id) / 2);
        _recv(_batch(3, 2, address(0), ids, us));
        (uint128[] memory paid,,) = _batchResult(3, 2);
        assertEq(paid[0], 0);
        assertEq(paid[1], us[1]);
    }

    function test_anUnlockedPositionPaysTheBatchFromWhatTheHoldersAreOwed() public {
        uint64 id = _open(10 ether);
        _earn();
        _recv(_unlock(id, 1));
        uint256 claim = vault.payableYield(id);
        assertGt(claim, 0);
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(claim * 3));
        _recv(_batch(1, 2, address(0), ids, us));
        (uint128[] memory paid,,) = _batchResult(1, 1);
        assertApproxEqAbs(paid[0], claim, 2, "capped by what the Position can still pay");
        assertApproxEqAbs(vault.escrowedUnits(), claim, 2);
        if (_isReal()) assertApproxEqAbs(vault.owedSharesOf(id), 0, 2);
    }

    function test_theBatchResultIsAnsweredFromTheVaultBalanceAndAShortVaultDoesNotRevert() public {
        uint64 id = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 2));
        vm.deal(address(vault), 0);
        uint256 sends = lz.sends();
        _recv(_batch(1, 2, address(0), ids, us)); // executes, cannot answer
        assertEq(lz.sends(), sends, "no fee, no message");
        assertGt(vault.escrowedUnits(), 0, "the work was done");
        // anyone can ask again and pay the fee
        vault.resendBatchResult{value: 0.001 ether}(1);
        assertEq(lz.sends(), sends + 1);
        _batchResult(1, 1);
    }

    function test_aBatchForAnotherVaultOrWithBadLengthReverts() public {
        uint64 id = _open(10 ether);
        (uint64[] memory ids, uint128[] memory us) = _one(id, 1);
        bytes memory m = _batch(1, 2, address(0), ids, us);
        // wrong vault in the key
        bytes memory other = abi.encodePacked(uint8(6), lz.eid(), bytes32(uint256(uint160(address(0xBEEF))) << 96));
        vm.prank(address(lz));
        vm.expectRevert(PositionVaultOApp.WrongVault.selector);
        vault.lzReceive(
            Origin(SOLANA, STORE, 1),
            bytes32(0),
            abi.encodePacked(other, uint64(1), _slice(m, 45, m.length - 45)),
            address(0),
            ""
        );
        // a batch key with a position-id word is not a route key
        bytes memory dirty = abi.encodePacked(uint8(6), lz.eid(), _key(1), uint64(1), _slice(m, 45, m.length - 45));
        vm.prank(address(lz));
        vm.expectRevert(PositionVaultOApp.WrongVault.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), dirty, address(0), "");
        // truncated
        vm.prank(address(lz));
        vm.expectRevert(PositionVaultOApp.InvalidMessageLength.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), _slice(m, 0, m.length - 1), address(0), "");
    }

    /// The executor gas the Solana side must grant a delivery on this chain (ticket 24 sets the lzReceive option).
    function test_gasOfAnEightEntryBatchAndAPrizeFitsTheReceiveBudget() public {
        uint64[] memory ids = new uint64[](8);
        uint128[] memory us = new uint128[](8);
        for (uint256 i; i < 8; i++) {
            ids[i] = _open(1 ether);
        }
        _earn();
        for (uint256 i; i < 8; i++) {
            us[i] = uint128(vault.payableYield(ids[i]) / 2);
        }
        bytes memory m = _batch(1, 2, address(0), ids, us);
        vm.prank(address(lz));
        uint256 g = gasleft();
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
        uint256 used = g - gasleft();
        emit log_named_uint("gas: 8-entry Leaderboard batch (first delivery)", used);
        assertLt(used, 1_500_000);
        bytes memory p = _prize(1, _token(), winner, uint128(vault.escrowShares() / 2));
        vm.prank(address(lz));
        g = gasleft();
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), p, address(0), "");
        used = g - gasleft();
        emit log_named_uint("gas: PayPrize", used);
        assertLt(used, 250_000);
    }

    // ---- PayPrize

    function _fillEscrow() internal returns (uint256 shares) {
        uint64 id = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 2));
        _recv(_batch(1, 2, address(0), ids, us));
        return vault.escrowShares();
    }

    function test_payPrizePaysOnlyFromTheEscrowAndWorksWithAnEmptyTreasury() public {
        uint256 esc = _fillEscrow();
        uint256 treasury = vault.treasuryBalance();
        uint128 take = uint128(esc / 2);
        _recv(_prize(1, _token(), winner, take));
        assertEq(_balance(winner), take);
        assertEq(vault.escrowShares(), esc - take);
        (uint8 status, uint128 shares) = _prizeResult(1);
        assertEq(status, 1);
        assertEq(shares, take);
        assertEq(vault.escrowedShares(), esc, "cumulative counter does not fall when prizes are paid");
        assertEq(vault.treasuryBalance(), treasury, "no Treasury money moved");
    }

    function test_payPrizeIsPaidOncePerPayoutIdAndTheAnswerIsRegenerated() public {
        uint256 esc = _fillEscrow();
        uint128 take = uint128(esc / 2);
        bytes memory m = _prize(5, _token(), winner, take);
        _recv(m);
        uint256 sends = lz.sends();
        _recv(m);
        _recv(m);
        assertEq(_balance(winner), take, "paid once");
        assertEq(lz.sends(), sends + 2, "answered on every delivery");
        (uint8 status,) = _prizeResult(5);
        assertEq(status, 1);
    }

    function test_payPrizeRejectionsAreFinalAndAnswered() public {
        uint256 esc = _fillEscrow();
        // wrong asset
        _recv(_prize(1, address(0xdead), winner, uint128(esc / 4)));
        (uint8 status,) = _prizeResult(1);
        assertEq(status, 2);
        // more than the escrow
        _recv(_prize(2, _token(), winner, uint128(esc + 1)));
        (status,) = _prizeResult(2);
        assertEq(status, 2);
        // a recipient word with dirty high bytes
        bytes memory dirty = abi.encodePacked(
            uint8(7),
            lz.eid(),
            _vaultKey(),
            uint64(3),
            bytes32(uint256(uint160(_token()))),
            bytes32(uint256(1)),
            bytes32(type(uint256).max),
            uint128(esc / 4)
        );
        _recv(dirty);
        (status,) = _prizeResult(3);
        assertEq(status, 2);
        // zero shares
        _recv(_prize(4, _token(), winner, 0));
        (status,) = _prizeResult(4);
        assertEq(status, 2);
        assertEq(vault.escrowShares(), esc, "nothing left the escrow");
        assertEq(_balance(winner), 0);

        // payout 2 was rejected for lack of escrow: a bigger escrow later must not make it pay
        uint64 id2 = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id2, uint128(vault.payableYield(id2) / 2));
        _recv(_batch(9, 2, address(0), ids, us));
        assertGt(vault.escrowShares(), esc);
        _recv(_prize(2, _token(), winner, uint128(esc + 1)));
        assertEq(_balance(winner), 0, "a rejected payout never pays");
        (status,) = _prizeResult(2);
        assertEq(status, 2);
    }

    function test_payPrizeNeverTouchesPositionsOrTheTreasury() public {
        uint256 esc = _fillEscrow();
        _fundTreasury(1 ether);
        uint256 treasury = vault.treasuryBalance();
        _recv(_prize(1, _token(), winner, uint128(esc)));
        assertEq(vault.escrowShares(), 0);
        assertEq(vault.treasuryBalance(), treasury, "Treasury untouched");
        // a second payout cannot dip into the Treasury
        _recv(_prize(2, _token(), winner, 1));
        (uint8 status,) = _prizeResult(2);
        assertEq(status, 2);
    }

    function _fundTreasury(uint256 shares) internal virtual;

    function test_treasuryWithdrawalAndInstantRedeemCannotSpendTheEscrow() public {
        uint256 esc = _fillEscrow();
        _fundTreasury(1 ether);
        uint256 t = vault.treasuryBalance();
        vault.withdrawTreasury(t, address(0xC0FFEE));
        assertEq(vault.escrowShares(), esc);
        assertEq(vault.treasuryBalance(), 0);
        // the escrow still pays in full
        _recv(_prize(1, _token(), winner, uint128(esc)));
        assertEq(_balance(winner), esc);
    }

    function test_theYieldReportCarriesTheCumulativeEscrowFigures() public {
        uint64 id = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 2));
        _recv(_batch(1, 2, address(0), ids, us));
        vault.reportYield{value: 0.0001 ether}(id);
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 133);
        assertEq(_u128At(m, 101), vault.escrowedShares());
        assertEq(_u128At(m, 117), vault.escrowedUnits());
        // paying a prize leaves the cumulative figures alone
        _recv(_prize(1, _token(), winner, uint128(vault.escrowShares())));
        vault.reportYield{value: 0.0001 ether}(id);
        m = lz.lastMessage();
        assertEq(_u128At(m, 101), vault.escrowedShares());
    }

    function test_escrowFiguresOnlyGrow() public {
        uint64 id = _open(10 ether);
        _earn();
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 4));
        _recv(_batch(1, 2, address(0), ids, us));
        uint256 s1 = vault.escrowedShares();
        uint256 u1 = vault.escrowedUnits();
        _recv(_prize(1, _token(), winner, uint128(vault.escrowShares() / 2)));
        _earn();
        (ids, us) = _one(id, uint128(vault.payableYield(id) / 4));
        _recv(_batch(2, 2, address(0), ids, us));
        assertGe(vault.escrowedShares(), s1);
        assertGt(vault.escrowedUnits(), u1);
    }
}

contract PrizeEscrowRealTest is EscrowBase {
    RateToken tok;

    function _setUpVault() internal override {
        tok = new RateToken();
        vault = new PositionVaultOApp(
            address(tok),
            address(new WstETHRateAdapter(address(tok))),
            address(lz),
            lz.eid(),
            SOLANA,
            address(this),
            address(0)
        );
        tok.mint(alice, 100 ether);
        vm.prank(alice);
        tok.approve(address(vault), type(uint256).max);
        tok.mint(address(this), 100 ether);
        tok.approve(address(vault), type(uint256).max);
    }

    function _token() internal view override returns (address) {
        return address(tok);
    }

    function _balance(address who) internal view override returns (uint256) {
        return tok.balanceOf(who);
    }

    function _isReal() internal pure override returns (bool) {
        return true;
    }

    uint256 internal bump;

    function _earn() internal override {
        bump += 1;
        tok.setRate(1.2e18 + bump * 0.06e18);
    }

    function _fundTreasury(uint256 shares) internal override {
        vault.fundTreasury(shares);
    }

    // ---- real-LST only: the Pool's half, funded into the escrow

    function test_cashOutSplitsTheFeeToTheTreasuryAndThePoolAndUnlockTakesNone() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18); // yield 1.2 on Pu 12
        _recv(_unlock(id, 1));
        assertEq(vault.poolOwedShares(), 0, "Unlock owes the Pool nothing");
        assertApproxEqAbs(vault.treasuryBalance(), 0, 4, "and gives the Treasury nothing");
        uint64 id2 = _open(10 ether);
        tok.setRate(1.5e18);
        (uint256 fee, uint256 pool) = _cashOut(id2, 1);
        assertApproxEqAbs(vault.poolOwedShares() * 1.5e18 / 1e18, pool, 4);
        assertApproxEqAbs(vault.treasuryBalance(), fee - pool, 4);
        assertGe(vault.treasuryShares(), vault.owedShares() + vault.poolOwedShares());
    }

    function test_theTreasuryCannotWithdrawOrInstantRedeemThePoolsPart() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _cashOut(id, 1);
        _recv(_unlock(id, 2));
        uint256 pool = vault.poolOwedShares();
        assertGt(pool, 1000);
        vault.withdrawTreasury(vault.treasuryBalance(), address(0xC0FFEE));
        assertEq(vault.poolOwedShares(), pool);
        assertLe(vault.treasuryBalance(), 2, "only share dust is left");
        // Instant Redeem cannot reach it either: ask for half of what the Pool is owed
        bytes memory instant = abi.encodePacked(
            uint8(5), lz.eid(), _key(id), uint64(3), bytes32(uint256(uint160(winner))), uint128(pool / 2)
        );
        vm.prank(address(lz));
        vm.expectPartialRevert(PositionVault.InsufficientTreasury.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), instant, address(0), "");
    }

    function test_fundPrizeEscrowMovesThePoolsPartAndOnlyAdminOrKeeperMay() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _cashOut(id, 1);
        _recv(_unlock(id, 2));
        uint256 pool = vault.poolOwedShares();
        uint256 spendable = vault.spendableTreasuryShares();
        uint256 t = vault.treasuryShares();

        vm.prank(alice);
        vm.expectRevert(PositionVault.NotAdminOrKeeper.selector);
        vault.fundPrizeEscrow(0);

        address keeper = address(0xBEE5);
        vault.setEscrowKeeper(keeper);
        vm.prank(keeper);
        vault.fundPrizeEscrow(0);

        assertEq(vault.poolOwedShares(), 0);
        assertEq(vault.escrowShares(), pool);
        assertEq(vault.escrowedShares(), pool);
        assertEq(vault.escrowedUnits(), pool * 1.32e18 / 1e18);
        assertEq(vault.spendableTreasuryShares(), spendable, "Treasury spendable is unchanged");
        assertEq(vault.treasuryShares(), t, "no token moved");
        assertGe(vault.treasuryShares(), vault.owedShares() + vault.escrowShares());

        vm.expectRevert(abi.encodeWithSelector(PositionVault.EscrowTooSmall.selector, 1, 0));
        vault.fundPrizeEscrow(1);
    }

    function test_aSlashAfterFundingIsCarriedByThePrizeSharesNeverByTheTreasuryOrPositions() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _cashOut(id, 1);
        _recv(_unlock(id, 2));
        vault.fundPrizeEscrow(0);
        uint256 esc = vault.escrowShares();
        uint256 spendable = vault.spendableTreasuryShares();
        tok.setRate(0.5e18); // a big slash
        assertEq(vault.escrowShares(), esc, "shares are fixed");
        assertEq(vault.spendableTreasuryShares(), spendable);
        _recv(_prize(1, address(tok), winner, uint128(esc)));
        assertEq(tok.balanceOf(winner), esc);
    }

    function test_theVaultStaysSolventThroughEscrowMoves() public {
        uint64 id = _open(10 ether);
        uint64 id2 = _open(4 ether);
        tok.setRate(1.32e18);
        (uint64[] memory ids, uint128[] memory us) = _one(id, uint128(vault.payableYield(id) / 2));
        _recv(_batch(1, 2, address(0), ids, us));
        _cashOut(id, 1);
        _recv(_unlock(id, 2));
        vault.fundPrizeEscrow(0);
        _recv(_prize(1, address(tok), winner, uint128(vault.escrowShares() / 2)));
        _recv(_unlock(id2, 1));
        uint256 held = vault.getPosition(id).heldShares + vault.getPosition(id2).heldShares;
        assertEq(tok.balanceOf(address(vault)), held + vault.treasuryShares());
        assertGe(vault.treasuryShares(), vault.owedShares() + vault.poolOwedShares() + vault.escrowShares());
    }
}

contract PrizeEscrowSimTest is EscrowBase {
    SimLST lst;

    function _setUpVault() internal override {
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        vault = new PositionVaultOApp(
            address(lst), address(lst), address(lz), lz.eid(), SOLANA, address(this), address(lst)
        );
        lst.setMinter(address(vault));
        lst.setFaucet(100 ether, 0);
        lst.faucet(alice);
        lst.faucet(address(this));
        vm.prank(alice);
        lst.approve(address(vault), type(uint256).max);
        lst.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
    }

    function _token() internal view override returns (address) {
        return address(lst);
    }

    function _balance(address who) internal view override returns (uint256) {
        return lst.balanceOf(who);
    }

    function _isReal() internal pure override returns (bool) {
        return false;
    }

    function _earn() internal override {
        vm.warp(block.timestamp + 10 minutes);
    }

    function _fundTreasury(uint256 shares) internal override {
        vault.fundTreasury(shares);
    }

    function test_simPoolOwesWhatSolanaNamedAndFundsTheEscrowByMinting() public {
        uint64 id = _open(10 ether);
        _earn();
        (, uint256 pool) = _cashOut(id, 1);
        uint256 owed = vault.poolOwedUnits();
        assertEq(owed, pool);
        assertGt(owed, 0);
        uint256 treasury = vault.treasuryBalance();
        uint256 supply = lst.totalSupply();
        vault.fundPrizeEscrow(0);
        assertEq(vault.poolOwedUnits(), 0);
        assertEq(vault.escrowedUnits(), owed);
        assertEq(lst.totalSupply(), supply + vault.escrowShares(), "minted into the vault only now");
        assertEq(vault.treasuryBalance(), treasury, "Treasury figure unchanged");
    }

    function test_simEscrowIsNotSpentByTreasuryWithdrawals() public {
        uint64 id = _open(10 ether);
        _earn();
        _cashOut(id, 1);
        vault.fundPrizeEscrow(0);
        uint256 esc = vault.escrowShares();
        _fundTreasury(1 ether);
        vault.withdrawTreasury(vault.treasuryBalance(), address(0xC0FFEE));
        assertEq(lst.balanceOf(address(vault)) >= esc, true, "escrow shares still held");
        _recv(_prize(1, address(lst), winner, uint128(esc)));
        assertEq(lst.balanceOf(winner), esc);
    }
}
