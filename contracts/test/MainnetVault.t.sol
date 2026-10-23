// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {PositionVaultBase} from "../src/PositionVaultBase.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {KHypeRateAdapter} from "../src/KHypeRateAdapter.sol";
import {IRateSource, IWstETH, IKinetiqAccountant} from "../src/IRateSource.sol";
import {MockLzEndpoint} from "./PositionVaultOApp.t.sol";

/// A staking token whose rate the test moves: serves as wstETH (`stEthPerToken`) and as Kinetiq's accountant.
contract RateToken is IWstETH, IKinetiqAccountant {
    uint256 public stEthPerToken = 1.2e18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setRate(uint256 r) external {
        stEthPerToken = r;
    }

    function kHYPEToHYPE(uint256 a) external view returns (uint256) {
        return a * stEthPerToken / 1e18;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// The mainnet vaults (wstETH on Ethereum, kHYPE on HyperEVM) are `PositionVaultOApp` on a rate adapter with no
/// yield minter. Same behaviour on both; only the adapter differs.
abstract contract MainnetVaultBase is Test {
    uint32 constant SOLANA = 30168;
    bytes32 constant STORE = bytes32(uint256(0x5702E));
    RateToken tok;
    MockLzEndpoint lz;
    PositionVaultOApp vault;
    address alice = address(0xA11CE);
    address redeemer = address(0xEDEE);

    function _adapter(address token) internal virtual returns (IRateSource);

    function setUp() public {
        tok = new RateToken();
        lz = new MockLzEndpoint();
        vault = new PositionVaultOApp(
            address(tok), address(_adapter(address(tok))), address(lz), lz.eid(), SOLANA, address(this), address(0)
        );
        vault.setPeer(SOLANA, STORE);
        tok.mint(alice, 100 ether);
        vm.deal(alice, 10 ether);
        vm.deal(address(this), 10 ether);
        vm.prank(alice);
        tok.approve(address(vault), type(uint256).max);
    }

    function _key(uint64 id) internal view returns (bytes32) {
        return bytes32((uint256(uint160(address(vault))) << 96) | (uint256(id) << 32));
    }

    function _open(uint256 amt) internal returns (uint64 id) {
        vm.prank(alice);
        id = vault.openPosition{value: 0.0002 ether}(amt, 12);
    }

    function _recv(bytes memory m) internal {
        vm.prank(address(lz));
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
    }

    /// PayYield (4) carries `amount | fee | pool` (exempt: 0, 0); PayInstant (5) carries `amount` only.
    function _pay(uint8 t, uint64 id, uint64 seq, address to, uint128 amt) internal view returns (bytes memory) {
        if (t == 4) return _payFee(id, seq, to, amt, 0, 0);
        return abi.encodePacked(t, lz.eid(), _key(id), seq, bytes32(uint256(uint160(to))), amt);
    }

    function _payFee(uint64 id, uint64 seq, address to, uint128 amt, uint128 fee, uint128 pool)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(uint8(4), lz.eid(), _key(id), seq, bytes32(uint256(uint160(to))), amt, fee, pool);
    }

    function _unlock(uint64 id, uint64 seq) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(3), lz.eid(), _key(id), seq, uint128(0));
    }

    function _report(uint64 id) internal returns (uint256 accrued, uint256 treasury, uint64 seq) {
        vault.reportYield{value: 0.0001 ether}(id);
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 133, "Yield Report is 133 bytes: 101 plus the escrow counters");
        assertEq(uint8(m[0]), 2);
        assertEq(bytes32(_slice(m, 5, 32)), _key(id));
        seq = uint64(bytes8(_slice(m, 37, 8)));
        accrued = uint128(bytes16(_slice(m, 45, 16)));
        treasury = uint128(bytes16(_slice(m, 61, 16)));
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }

    function _fund(uint256 shares) internal {
        tok.mint(address(this), shares);
        tok.approve(address(vault), shares);
        vault.fundTreasury(shares);
    }

    // ---------------------------------------------------------------- Treasury in shares (slashing)

    function test_withdrawAfterSlashLeavesOpenPositionYieldPayable() public {
        uint64 id = _open(10 ether); // 12 underlying at 1.2
        tok.setRate(1.32e18);
        _fund(1 ether);
        tok.setRate(1.25e18); // slash
        vault.withdrawTreasury(vault.treasuryBalance(), address(this));
        uint256 owed = vault.payableYield(id);
        _recv(_pay(4, id, 1, redeemer, uint128(owed)));
        assertEq(vault.payableYield(id), 0);
    }

    function test_withdrawAfterSlashLeavesUnlockedPositionYieldPayable() public {
        uint64 id = _open(10 ether);
        _fund(1 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(id, 1));
        tok.setRate(1.188e18); // -10% after Unlock
        vault.withdrawTreasury(vault.treasuryBalance(), address(this));
        uint256 owed = vault.payableYield(id);
        _recv(_pay(4, id, 2, redeemer, uint128(owed)));
        assertEq(vault.payableYield(id), 0);
    }

    /// Instant Redeem used to spend open fees; a fall back to the open rate then made Unlock underflow.
    function test_unlockReturnsPrincipalAfterInstantSpentOpenFeesAndRateFell() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint256 spendable = vault.treasuryBalance();
        if (spendable > 0) _recv(_pay(5, id, 1, redeemer, uint128(spendable)));
        tok.setRate(1.2e18);
        uint256 before = tok.balanceOf(alice);
        _recv(_unlock(id, 2));
        assertEq(tok.balanceOf(alice) - before, 10 ether, "full Principal back");
    }

    // ---------------------------------------------------------------- tests

    // ---- Treasury in shares: spec .scratch/treasury-in-shares (D1 realised-only, D2 holders carry slashes, D3 no cushion)

    function _sumHeld(uint64 n) internal view returns (uint256 s) {
        for (uint64 i = 1; i <= n; i++) {
            s += vault.getPosition(i).heldShares;
        }
    }

    function _instant(uint64 id, uint64 seq, uint256 amt) internal {
        _recv(_pay(5, id, seq, redeemer, uint128(amt)));
    }

    function test_treasuryEarnsStakingYieldOnFundedShares() public {
        _fund(10 ether); // 12 underlying at 1.2
        assertEq(vault.treasuryBalance(), 12 ether);
        tok.setRate(1.32e18);
        assertEq(vault.treasuryBalance(), 13.2 ether, "1.1x the funded underlying");
    }

    function test_slashLowersTheTreasuryOnlyByItsOwnLoss() public {
        uint64 id = _open(10 ether);
        _fund(10 ether);
        tok.setRate(1.08e18); // -10%
        assertEq(vault.treasuryBalance(), 10.8 ether, "only the funded shares lost value");
        assertEq(vault.getPosition(id).heldShares, 10 ether, "the Position's shares are untouched");
    }

    function test_openFeesAreNotSpendable() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        assertEq(vault.treasuryBalance(), 0);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 1, 0));
        vault.withdrawTreasury(1, address(this));
        bytes memory one = _pay(5, id, 1, redeemer, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 1, 0));
        _recv(one);
        _fund(1 ether);
        uint256 t = vault.treasuryBalance();
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, t + 1, t));
        vault.withdrawTreasury(t + 1, address(this));
    }

    function test_unlockMovesTheLeftoverIntoTheTreasuryAndRecordsTheClaimInShares() public {
        uint64 id = _open(10 ether); // Pu 12
        tok.setRate(1.32e18); // yield 1.2, all of it owed to the holders: no fee at Unlock
        _recv(_unlock(id, 1));
        uint256 released = tok.balanceOf(alice) - 90 ether;
        assertEq(vault.getPosition(id).heldShares, 0);
        assertEq(vault.treasuryShares(), 10 ether - released, "everything not released is the Treasury's");
        assertEq(vault.unlockRate(id), 1.32e18);
        assertEq(vault.owedSharesOf(id), uint256(1.2 ether) * 1e18 / 1.32e18);
        assertEq(vault.owedShares(), vault.owedSharesOf(id));
        assertApproxEqAbs(vault.treasuryBalance(), 0, 4, "nothing spendable: the whole leftover is the holders'");
        assertEq(vault.poolOwedShares(), 0, "Unlock owes the Pool nothing");
        assertEq(tok.balanceOf(address(vault)), vault.treasuryShares());
    }

    /// Unlock A, withdraw the whole Treasury, then a slash: A's holders are still paid in full (in shares), and
    /// the open Position B keeps every share it held.
    function test_slashAfterAFullWithdrawalPaysUnlockedHoldersAndTouchesNoOpenPosition() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(10 ether);
        _fund(1 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(a, 1));
        vault.withdrawTreasury(vault.treasuryBalance(), address(this));
        uint256 heldB = vault.getPosition(b).heldShares;
        tok.setRate(1.254e18); // -5%
        uint256 owedA = vault.payableYield(a);
        _recv(_pay(4, a, 2, redeemer, uint128(owedA)));
        assertEq(vault.payableYield(a), 0);
        assertEq(vault.getPosition(b).heldShares, heldB);
        assertEq(vault.owedShares(), 0);
        // the holder carried the slash: their shares were fixed at the Unlock rate
        assertApproxEqAbs(tok.balanceOf(redeemer), owedA * 1e18 / 1.32e18, 2);
        _recv(_pay(4, b, 1, redeemer, uint128(vault.payableYield(b))));
        _recv(_unlock(b, 2));
    }

    /// Unlock, slash, then Tesoro's redeemed Gemas of the unlocked Position come back to the vault: the claim
    /// becomes Treasury ownership and is spendable.
    function test_unlockThenSlashThenRefillOfAnUnlockedPositionsGemas() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(id, 1));
        tok.setRate(1.188e18);
        uint256 spendableBefore = vault.spendableTreasuryShares();
        uint256 sharesBefore = vault.treasuryShares();
        uint256 owed = vault.payableYield(id);
        _recv(_pay(4, id, 2, address(vault), uint128(owed)));
        assertEq(vault.treasuryShares(), sharesBefore, "no shares move");
        assertEq(vault.owedShares(), 0);
        assertApproxEqAbs(
            vault.spendableTreasuryShares(), spendableBefore + owed * 1e18 / 1.32e18, 2, "the claim is now spendable"
        );
        vault.withdrawTreasury(vault.treasuryBalance(), address(this));
    }

    /// Solana accepted an Instant claim against a higher report; a slash then leaves the Treasury short. The
    /// PayInstant waits (nothing recorded) and the owner's `fundTreasury` releases it.
    function test_instantClaimAcceptedBeforeASlashWaitsForFunding() public {
        uint64 id = _open(10 ether);
        _fund(10 ether);
        tok.setRate(1.32e18);
        (, uint256 reported,) = _report(id);
        assertEq(reported, 13.2 ether);
        tok.setRate(1.2e18); // slash: the Treasury is 12 now
        bytes memory claim = _pay(5, id, 2, redeemer, uint128(13.2 ether));
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 13.2 ether, 12 ether));
        _recv(claim);
        assertEq(vault.instantPaid(), 0);
        _fund(1 ether);
        _recv(claim);
        assertEq(vault.instantPaid(), 13.2 ether);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.2e18 / 1e18, 13.2 ether, 2);
    }

    /// Instant Redeem racing an Unlock, both orders, with a rate fall between: Principal comes back whole.
    function test_instantRedeemRacingAnUnlockNeverStrandsPrincipal() public {
        uint64 a = _open(10 ether);
        _fund(2 ether);
        tok.setRate(1.32e18);
        _instant(a, 1, vault.treasuryBalance()); // drains the Treasury to the floor
        tok.setRate(1.2e18);
        uint256 before = tok.balanceOf(alice);
        _recv(_unlock(a, 2));
        assertEq(tok.balanceOf(alice) - before, 10 ether);
        // other order: a cash-out takes a fee, Unlock, then Instant against that fee
        uint64 b = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(b) / 2);
        _recv(_payFee(b, 1, redeemer, amt, amt / 5, 0));
        _recv(_unlock(b, 2));
        uint256 fee = vault.treasuryBalance();
        assertGt(fee, 0);
        _instant(b, 3, fee);
        assertLe(vault.treasuryBalance(), 1);
    }

    /// A slash under one open Position's rate must not block an unlocked Position's holders or the owner: only
    /// the Treasury's own shares are in play.
    function test_slashBelowAnOpenPositionsRateDoesNotBlockUnlockedHolders() public {
        uint64 a = _open(10 ether); // opens at 1.2
        tok.setRate(1.32e18);
        uint64 b = _open(10 ether); // opens at 1.32
        tok.setRate(1.4e18);
        _recv(_unlock(a, 1));
        tok.setRate(1.25e18); // below b's open rate
        _recv(_pay(4, a, 2, redeemer, uint128(vault.payableYield(a))));
        assertEq(vault.payableYield(a), 0);
        uint256 w = vault.treasuryBalance();
        if (w > 0) vault.withdrawTreasury(w, address(this));
        assertEq(vault.getPosition(b).heldShares, 10 ether);
        uint256 before = tok.balanceOf(alice);
        _recv(_unlock(b, 1));
        assertEq(tok.balanceOf(alice) - before, 10 ether, "all of b's shares come back");
    }

    /// Rounding always favours the vault: a Position paid in many tiny pieces never exceeds what it was owed.
    function test_manySmallPayoutsOfAnUnlockedPositionNeverExceedTheClaim() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.31e18);
        _recv(_unlock(id, 1));
        uint256 owed = vault.payableYield(id);
        uint256 piece = owed / 7;
        uint64 seq = 2;
        while (vault.payableYield(id) > 0) {
            uint256 amt = vault.payableYield(id) < piece ? vault.payableYield(id) : piece;
            _recv(_pay(4, id, seq++, redeemer, uint128(amt)));
        }
        assertLe(tok.balanceOf(redeemer), owed * 1e18 / 1.31e18);
        assertLe(vault.owedShares(), 7, "at most dust left");
        assertGe(vault.treasuryShares(), vault.owedShares());
    }

    /// Fuzz: one Position, any rate path, unlock at a rate, a slash after: unlocked holders are always paid and
    /// the Treasury always holds what it owes.
    function testFuzz_unlockedHoldersAlwaysPayable(uint256 r1, uint256 r2, uint256 r3, uint256 fund, uint256 cut)
        public
    {
        r1 = bound(r1, 1.2e18, 3e18);
        r2 = bound(r2, 0.5e18, 3e18);
        r3 = bound(r3, 0.5e18, 3e18);
        fund = bound(fund, 0, 5 ether);
        uint64 id = _open(10 ether);
        if (fund > 0) _fund(fund);
        tok.setRate(r1);
        _recv(_unlock(id, 1));
        assertGe(vault.treasuryShares(), vault.owedShares());
        tok.setRate(r2);
        uint256 w = vault.treasuryBalance();
        if (w > 0) vault.withdrawTreasury(w, address(this));
        tok.setRate(r3);
        uint256 owed = vault.payableYield(id);
        cut = bound(cut, 0, 100);
        uint256 first = owed * cut / 100;
        uint64 seq = 2;
        if (first > 0) _recv(_pay(4, id, seq++, redeemer, uint128(first)));
        if (owed - first > 0) _recv(_pay(4, id, seq++, redeemer, uint128(owed - first)));
        assertEq(vault.payableYield(id), 0);
        assertGe(vault.treasuryShares(), vault.owedShares());
        assertEq(tok.balanceOf(address(vault)), vault.treasuryShares());
    }

    // ---- Attempts to break it (each one a test)

    /// Rounding direction: shares paid out of the Treasury are rounded down, so whoever is paid never receives
    /// more than the underlying amount asked for, and the Treasury never loses more than it spent.
    function testFuzz_withdrawAndInstantNeverOverpay(uint256 rate, uint256 amount, bool instant) public {
        rate = bound(rate, 0.5e18, 4e18);
        uint64 id = _open(10 ether);
        _fund(10 ether);
        tok.setRate(rate);
        uint256 avail = vault.treasuryBalance();
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        uint256 sharesBefore = vault.treasuryShares();
        address to = address(0xFEED);
        if (instant) _instant(id, 1, amount);
        else vault.withdrawTreasury(amount, to);
        address who = instant ? redeemer : to;
        assertLe(tok.balanceOf(who) * rate / 1e18, amount, "never paid more than asked");
        assertEq(sharesBefore - vault.treasuryShares(), tok.balanceOf(who), "T falls by exactly the shares sent");
        uint256 left = vault.treasuryBalance();
        assertGe(left + amount + 1, avail, "the Treasury lost at most what it paid");
        assertLe(left, avail - amount + rate / 1e18 + 2, "and at least that, less one share-wei of rounding");
    }

    /// Shares sent to the vault by anyone do not change the Treasury figure or anything a holder is owed.
    function test_donatedSharesChangeNothing() public {
        uint64 id = _open(10 ether);
        _fund(1 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(id, 1));
        uint256 t = vault.treasuryBalance();
        uint256 owed = vault.owedShares();
        tok.mint(address(vault), 5 ether);
        assertEq(vault.treasuryBalance(), t);
        assertEq(vault.owedShares(), owed);
        vault.withdrawTreasury(t, address(this));
        assertEq(tok.balanceOf(address(vault)), 5 ether + vault.treasuryShares(), "the donation is nobody's claim");
    }

    /// Audit E-1 shape: yield was paid to a player, the rate fell back, Unlock still goes through, and the Treasury
    /// still holds at least what it owes (the shortfall is the Player's, not the holders').
    function test_unlockAfterPaidYieldAndFallKeepsTheTreasuryAboveWhatItOwes() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(10 ether);
        tok.setRate(1.32e18);
        _recv(_pay(4, a, 1, redeemer, uint128(vault.payableYield(a) / 2)));
        tok.setRate(1.2e18);
        _recv(_unlock(a, 2));
        assertGe(vault.treasuryShares(), vault.owedShares());
        assertEq(vault.getPosition(b).heldShares, 10 ether, "b untouched");
        uint256 before = tok.balanceOf(alice);
        _recv(_unlock(b, 1));
        assertEq(tok.balanceOf(alice) - before, 10 ether);
    }

    /// A claim reported while unlocked is frozen in underlying and fixed in shares: a slash between the report and
    /// the PayYield changes what the shares are worth, never whether they are paid.
    function test_slashBetweenReportAndPayYieldOfAnUnlockedPosition() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(id, 1));
        (uint256 reported,,) = _report(id);
        tok.setRate(0.9e18);
        _recv(_pay(4, id, 2, redeemer, uint128(reported)));
        assertEq(vault.payableYield(id), 0);
        assertApproxEqAbs(tok.balanceOf(redeemer), reported * 1e18 / 1.32e18, 1);
    }

    /// Same for an open Position: after the slash the report is no longer payable in full (the formula follows
    /// the rate) and nothing is taken from anyone else; it pays what is accrued.
    function test_slashBetweenReportAndPayYieldOfAnOpenPosition() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(10 ether);
        tok.setRate(1.32e18);
        (uint256 reported,,) = _report(a);
        tok.setRate(1.26e18);
        bytes memory full = _pay(4, a, 2, redeemer, uint128(reported));
        vm.expectPartialRevert(PositionVaultBase.ExceedsAccruedYield.selector);
        _recv(full);
        _recv(_pay(4, a, 2, redeemer, uint128(vault.payableYield(a))));
        assertEq(vault.getPosition(b).heldShares, 10 ether);
    }

    /// The owner withdraws the whole spendable Treasury right after a slash, with an unlocked holder and an open
    /// Position both owed: both still get paid.
    function test_ownerWithdrawsTheWholeTreasuryRightAfterASlash() public {
        uint64 a = _open(10 ether);
        uint64 b = _open(10 ether);
        _fund(1 ether);
        tok.setRate(1.32e18);
        _recv(_unlock(a, 1));
        tok.setRate(1.188e18);
        vault.withdrawTreasury(vault.treasuryBalance(), address(this));
        _recv(_pay(4, a, 2, redeemer, uint128(vault.payableYield(a))));
        assertEq(vault.payableYield(a), 0);
        uint256 owedB = vault.payableYield(b);
        if (owedB > 0) _recv(_pay(4, b, 1, redeemer, uint128(owedB)));
        _recv(_unlock(b, 2));
    }

    function test_accruedYieldIsRealRateGrowth() public {
        uint64 id = _open(10 ether); // 12 underlying at 1.2
        PositionVaultBase.Position memory p = vault.getPosition(id);
        assertEq(p.principalUnderlying, 12 ether);
        assertEq(vault.accruedYield(id), 0);
        tok.setRate(1.26e18); // +5% growth since open: 0.6, all of it reported (the fee comes at cash-out)
        assertApproxEqAbs(vault.accruedYield(id), 0.6 ether, 2, "gross");
        assertEq(vault.treasuryBalance(), 0, "open yield is not spendable");
        tok.setRate(1.32e18); // +10%
        assertApproxEqAbs(vault.accruedYield(id), 1.2 ether, 2);
        _recv(_unlock(id, 1));
        assertApproxEqAbs(vault.treasuryBalance(), 0, 4, "Unlock takes no fee");
    }

    function test_yieldReportIs133BytesWithAccruedTreasuryAndEscrow() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.26e18);
        (uint256 accrued, uint256 treasury, uint64 seq) = _report(id);
        assertEq(seq, 2, "seq 1 was PositionLocked");
        assertApproxEqAbs(accrued, 0.6 ether, 2, "the report carries the gross yield");
        assertEq(treasury, 0, "an open Position's yield is not in the Treasury figure");
        assertEq(lz.lastOptions(), abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), uint128(200_000)));
    }

    /// Rate dip (kHYPE can be slashed): growth below the open rate is zero yield, never negative or a revert.
    function test_dipBelowTheOpenRateClampsYieldAndFeeAtZero() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.1e18);
        assertEq(vault.accruedYield(id), 0);
        assertEq(vault.payableYield(id), 0);
        assertEq(vault.treasuryBalance(), 0);
        (uint256 accrued, uint256 treasury,) = _report(id);
        assertEq(accrued, 0, "a report is still sendable: nothing earned yet");
        assertEq(treasury, 0);
    }

    function test_dipThenRecoveryResumesFromTheOpenRate() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.1e18);
        tok.setRate(1.26e18);
        assertApproxEqAbs(vault.accruedYield(id), 0.6 ether, 2, "growth is measured from the open rate");
    }

    /// Solana refuses a lower cumulative (CumulativeDecreased). After a rate fall the Report repeats the highest
    /// figure sent instead of reverting, so the Treasury balance and Instant payouts it carries never freeze.
    function test_reportAfterARateFallRepeatsTheHighWaterMarkAndStillSends() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        (uint256 first,,) = _report(id);
        tok.setRate(1.25e18);
        assertLt(vault.accruedYield(id), first);
        uint256 sends = lz.sends();
        (uint256 dipped,,) = _report(id);
        assertEq(dipped, first, "carries the high-water mark");
        assertEq(lz.sends(), sends + 1, "sent");
        assertEq(vault.getPosition(id).outSeq, 3, "seq spent");
        tok.setRate(1.4e18);
        (uint256 later,,) = _report(id);
        assertGt(later, first);
    }

    function test_payYieldIsRetryableWhileTheRateIsDippedBelowWhatWasPaid() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        _recv(_pay(4, id, 1, redeemer, uint128(vault.payableYield(id))));
        tok.setRate(1.1e18); // slashing after the payout
        assertEq(vault.payableYield(id), 0);
        bytes memory m = _pay(4, id, 2, redeemer, 1);
        vm.prank(address(lz));
        vm.expectPartialRevert(PositionVaultBase.ExceedsAccruedYield.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
        tok.setRate(1.4e18);
        assertGt(vault.payableYield(id), 0);
        _recv(_pay(4, id, 2, redeemer, 1)); // the same message succeeds once the rate recovers
    }

    /// The Treasury holds only fees taken at cash-out: a dipped Position must not lower the fee taken on another,
    /// and the Pool's part is never above what the Treasury gained.
    function test_treasuryHoldsExactlyTheFeesTakenAtCashOut() public {
        uint64 a = _open(10 ether); // opens at 1.2
        tok.setRate(1.32e18);
        uint64 b = _open(10 ether); // opens at 1.32
        tok.setRate(1.26e18); // a is +5%, b is -4.5%
        assertEq(vault.accruedYield(b), 0);
        assertEq(vault.treasuryBalance(), 0, "open yield is not spendable");
        tok.setRate(1.4e18); // both above their open rate
        uint128 amtA = uint128(vault.payableYield(a) / 2);
        uint128 amtB = uint128(vault.payableYield(b) / 2);
        _recv(_payFee(a, 1, redeemer, amtA, amtA / 5, amtA / 10));
        _recv(_payFee(b, 1, redeemer, amtB, amtB / 5, amtB / 10));
        uint256 fees = amtA / 5 + amtB / 5;
        uint256 pool = amtA / 10 + amtB / 10;
        assertApproxEqAbs(vault.treasuryBalance(), fees - pool, 8);
        assertApproxEqAbs(vault.poolOwedShares() * 1.4e18 / 1e18, pool, 8);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.4e18 / 1e18, amtA + amtB - fees, 8, "holders get the net");
        _recv(_unlock(a, 2));
        _recv(_unlock(b, 2));
        assertApproxEqAbs(vault.treasuryBalance(), fees - pool, 8, "Unlock changes nothing");
        assertGe(
            vault.treasuryShares(),
            vault.owedShares() + vault.poolOwedShares() + vault.escrowShares() + vault.reservedShares()
        );
    }

    function test_unlockAfterADipReturnsAllSharesAndKeepsNoYield() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.1e18);
        _recv(_unlock(id, 1));
        assertEq(tok.balanceOf(alice), 100 ether, "all shares back; their value fell with the rate");
        assertEq(vault.accruedYield(id), 0);
    }

    /// Audit 2026-10-16 E-1, founder decision pending (who bears a Staking Rate fall after yield was paid out:
    /// the Treasury, every Player, or the holder of the Gemas). This documents what the vault does today: the
    /// shares paid out as yield no longer back the Principal, so after a fall the Position unlocks for less than
    /// its Principal even though the Treasury still holds shares it took as fees. Change the assertions with the
    /// policy.
    function test_policyPending_aRateFallAfterAPayoutLeavesPrincipalShort() public {
        uint64 id = _open(10 ether); // Principal 12 underlying at 1.2
        tok.setRate(1.32e18);
        _recv(_pay(4, id, 1, redeemer, uint128(vault.payableYield(id)))); // all yield paid, in shares
        tok.setRate(1.2e18); // back to the open rate: no yield, Principal must be whole
        _recv(_unlock(id, 2));
        uint256 returned = tok.balanceOf(alice) - 90 ether; // shares released to the owner
        uint256 principalShares = 10 ether; // 12 underlying at 1.2
        assertLt(returned, principalShares, "Principal is short by the shares paid out as yield");
        uint256 shortfall = principalShares - returned;
        // The Treasury's fee shares are not enough to make the Player whole on their own.
        assertGt(shortfall, 0.5 ether);
        assertLt(tok.balanceOf(address(vault)), 1 ether, "only fee shares (none here) are left in the vault");
    }

    function test_unlockReleasesPrincipalAndFreezesTheYield() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint256 accrued = vault.accruedYield(id);
        _recv(_unlock(id, 1));
        tok.setRate(1.5e18);
        assertEq(vault.accruedYield(id), accrued);
        // Principal (12 underlying) back in shares at 1.32
        assertApproxEqAbs((tok.balanceOf(alice) - 90 ether) * 1.32e18 / 1e18, 12 ether, 2);
    }

    function test_payYieldPaysInTokensWorthTheAmountAndTheMessageIs125Bytes() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(id) / 2);
        bytes memory m = _pay(4, id, 1, redeemer, amt);
        assertEq(m.length, 125, "header 45 | to 32 | amount 16 | fee 16 | pool 16");
        _recv(m);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.32e18 / 1e18, amt, 2);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
    }

    function test_payYieldWithAFeePaysTheHolderTheNetAndRefusesALyingSplit() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(id) / 2);
        bytes memory lying = _payFee(id, 1, redeemer, amt, amt + 1, 0);
        vm.prank(address(lz));
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.BadFeeSplit.selector, amt, amt + 1, 0));
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), lying, address(0), "");
        _recv(_payFee(id, 1, redeemer, amt, amt / 5, amt / 10));
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.32e18 / 1e18, amt - amt / 5, 2);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
    }

    /// Audit 2026-10-16 B-1. The vault used to refuse a PayInstant it could not cover and send a
    /// refund message that Solana cannot read, so the holder lost the Gemas the Treasury had taken. A payout the
    /// Treasury cannot cover now reverts (nothing is recorded as handled) and the same message pays once it can.
    function test_instantRedeemPaysFromTheTreasuryElseWaitsForIt() public {
        uint64 id = _open(10 ether);
        _fund(1 ether); // 1.2 underlying at 1.2: the Treasury is funded, as the runbook says
        tok.setRate(1.32e18);
        uint128 fee = uint128(vault.treasuryBalance());
        assertApproxEqAbs(fee, 1.32 ether, 2, "the funded shares earn staking yield");
        _recv(_pay(5, id, 1, redeemer, fee));
        assertEq(vault.instantPaid(), fee);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.32e18 / 1e18, fee, 2);

        bytes memory short = _pay(5, id, 2, redeemer, 0.9 ether);
        vm.expectRevert(abi.encodeWithSelector(PositionVaultBase.InsufficientTreasury.selector, 0.9 ether, 0));
        _recv(short);
        assertEq(vault.instantPaid(), fee, "nothing paid, nothing recorded");

        // The Treasury is refilled; the same message, delivered again, pays exactly once.
        _fund(1 ether); // the owner funds it
        assertGe(vault.treasuryBalance(), 0.9 ether);
        uint256 before = tok.balanceOf(redeemer);
        _recv(short);
        assertGt(tok.balanceOf(redeemer), before);
        assertEq(vault.instantPaid(), fee + 0.9 ether);
        _recv(short); // a replay of a paid message is ignored
        assertEq(vault.instantPaid(), fee + 0.9 ether);
    }

    function test_treasuryFillsWithTheRefillAndWithdrawsToTheOwner() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(id));
        _recv(_pay(4, id, 1, address(vault), amt)); // Tesoro's redeemed Gemas return to the vault Treasury
        assertApproxEqAbs(vault.treasuryShares(), uint256(amt) * 1e18 / 1.32e18, 2);
        uint256 t = vault.treasuryBalance();
        assertApproxEqAbs(t, amt, 2);
        vault.withdrawTreasury(t, address(0xC0FFEE));
        assertLe(vault.treasuryBalance(), 1, "at most a wei of rounding dust stays");
        assertApproxEqAbs(tok.balanceOf(address(0xC0FFEE)) * 1.32e18 / 1e18, t, 2);
        _recv(_unlock(id, 2));
        assertApproxEqAbs((tok.balanceOf(alice) - 90 ether) * 1.32e18 / 1e18, 12 ether, 2, "Principal untouched");
    }

    function test_onlyTheOwnerWithdrawsAndTheEndpointDelivers() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdrawTreasury(1, alice);
        bytes memory m = _unlock(id, 1);
        vm.expectRevert();
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
    }
}

contract WstETHMainnetVaultTest is MainnetVaultBase {
    function _adapter(address token) internal override returns (IRateSource) {
        return new WstETHRateAdapter(token);
    }
}

contract KHypeMainnetVaultTest is MainnetVaultBase {
    function _adapter(address token) internal override returns (IRateSource) {
        return new KHypeRateAdapter(token);
    }
}

/// The enforced options of the Solana to EVM pathway grant 250,000 gas (bridge/scripts/lz-mainnet.ts).
contract MainnetReceiveGasTest is MainnetVaultBase {
    function _adapter(address token) internal override returns (IRateSource) {
        return new WstETHRateAdapter(token);
    }

    function test_everyInboundMessageFitsTheEnforcedReceiveGas() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        bytes memory pay = _pay(4, id, 1, redeemer, uint128(vault.payableYield(id) / 2));
        bytes memory instant = _pay(5, id, 2, redeemer, uint128(vault.treasuryBalance() / 2));
        bytes memory unlock = _unlock(id, 3);
        bytes[3] memory msgs = [pay, instant, unlock];
        for (uint256 i; i < 3; i++) {
            vm.prank(address(lz));
            uint256 g = gasleft();
            vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), msgs[i], address(0), "");
            assertLt(g - gasleft(), 200_000, "well under 250,000");
        }
    }
}
