// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {PositionVault} from "../src/PositionVault.sol";
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

    function _pay(uint8 t, uint64 id, uint64 seq, address to, uint128 amt) internal view returns (bytes memory) {
        return abi.encodePacked(t, lz.eid(), _key(id), seq, bytes32(uint256(uint160(to))), amt);
    }

    function _unlock(uint64 id, uint64 seq) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(3), lz.eid(), _key(id), seq, uint128(0));
    }

    function _report(uint64 id) internal returns (uint256 accrued, uint256 treasury, uint64 seq) {
        vault.reportYield{value: 0.0001 ether}(id);
        bytes memory m = lz.lastMessage();
        assertEq(m.length, 93, "Yield Report is 93 bytes");
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

    // ---------------------------------------------------------------- tests

    function test_accruedYieldIsRealRateGrowthLessTheYieldFee() public {
        uint64 id = _open(10 ether); // 12 underlying at 1.2
        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.principalUnderlying, 12 ether);
        assertEq(vault.accruedYield(id), 0);
        tok.setRate(1.26e18); // +5% growth since open: 0.6 gross
        assertApproxEqAbs(vault.accruedYield(id), 0.48 ether, 2, "80% of 0.6");
        assertApproxEqAbs(vault.treasuryBalance(), 0.12 ether, 2, "20% to the Treasury at the source");
        tok.setRate(1.32e18); // +10%
        assertApproxEqAbs(vault.accruedYield(id), 0.96 ether, 2);
    }

    function test_yieldReportIs93BytesWithAccruedAndTreasury() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.26e18);
        (uint256 accrued, uint256 treasury, uint64 seq) = _report(id);
        assertEq(seq, 2, "seq 1 was PositionLocked");
        assertApproxEqAbs(accrued, 0.48 ether, 2);
        assertApproxEqAbs(treasury, 0.12 ether, 2);
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
        assertApproxEqAbs(vault.accruedYield(id), 0.48 ether, 2, "growth is measured from the open rate");
    }

    /// Solana refuses a lower cumulative (CumulativeDecreased), so a Report that fell below one already sent would
    /// fail there after the Player paid the LayerZero fee. The vault refuses to send it.
    function test_reportBelowTheLastReportIsRefusedUntilTheRateRecovers() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        (uint256 first,,) = _report(id);
        tok.setRate(1.25e18);
        assertLt(vault.accruedYield(id), first);
        uint256 sends = lz.sends();
        vm.expectPartialRevert(PositionVault.YieldBelowReported.selector);
        vault.reportYield{value: 0.0001 ether}(id);
        assertEq(lz.sends(), sends, "nothing sent");
        assertEq(vault.getPosition(id).outSeq, 2, "no seq spent");
        tok.setRate(1.32e18);
        _report(id); // the same figure is fine
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
        vm.expectPartialRevert(PositionVault.ExceedsAccruedYield.selector);
        vault.lzReceive(Origin(SOLANA, STORE, 1), bytes32(0), m, address(0), "");
        tok.setRate(1.4e18);
        assertGt(vault.payableYield(id), 0);
        _recv(_pay(4, id, 2, redeemer, 1)); // the same message succeeds once the rate recovers
    }

    /// The Treasury claim comes from pool totals: a dipped Position must not lower the fee earned on another.
    function test_treasuryNeverClaimsMoreThanThePerPositionFees() public {
        uint64 a = _open(10 ether); // opens at 1.2
        tok.setRate(1.32e18);
        uint64 b = _open(10 ether); // opens at 1.32
        tok.setRate(1.26e18); // a is +5%, b is -4.5%
        assertEq(vault.accruedYield(b), 0);
        uint256 feeA = (vault.accruedYield(a) * 2000) / 8000;
        assertLe(vault.treasuryBalance(), feeA + 4, "never above the fee of Positions that earned");
        tok.setRate(1.4e18); // both above their open rate
        uint256 sum = ((vault.accruedYield(a) * 2000) / 8000) + ((vault.accruedYield(b) * 2000) / 8000);
        assertApproxEqAbs(vault.treasuryBalance(), sum, 8);
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
    /// its Principal even though the Treasury still holds its Yield Fee shares. Change the assertions with the
    /// policy.
    function test_policyPending_aRateFallAfterAPayoutLeavesPrincipalShort() public {
        uint64 id = _open(10 ether); // Principal 12 underlying at 1.2
        tok.setRate(1.32e18);
        _recv(_pay(4, id, 1, redeemer, uint128(vault.payableYield(id)))); // all net yield paid, in shares
        tok.setRate(1.2e18); // back to the open rate: no yield, Principal must be whole
        _recv(_unlock(id, 2));
        uint256 returned = tok.balanceOf(alice) - 90 ether; // shares released to the owner
        uint256 principalShares = 10 ether; // 12 underlying at 1.2
        assertLt(returned, principalShares, "Principal is short by the shares paid out as yield");
        uint256 shortfall = principalShares - returned;
        // The Treasury's fee shares are not enough to make the Player whole on their own.
        assertGt(shortfall, 0.5 ether);
        assertLt(tok.balanceOf(address(vault)), 1 ether, "only the Yield Fee shares are left in the vault");
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

    function test_payYieldPaysInTokensWorthTheAmountAndTheMessageIs93Bytes() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 amt = uint128(vault.payableYield(id) / 2);
        bytes memory m = _pay(4, id, 1, redeemer, amt);
        assertEq(m.length, 93);
        _recv(m);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.32e18 / 1e18, amt, 2);
        assertEq(vault.getPosition(id).paidUnderlying, amt);
    }

    /// Audit 2026-10-16 B-1. The vault used to refuse a PayInstant it could not cover and send a
    /// refund message that Solana cannot read, so the holder lost the Gemas the Treasury had taken. A payout the
    /// Treasury cannot cover now reverts (nothing is recorded as handled) and the same message pays once it can.
    function test_instantRedeemPaysFromTheTreasuryElseWaitsForIt() public {
        uint64 id = _open(10 ether);
        tok.setRate(1.32e18);
        uint128 fee = uint128(vault.treasuryBalance());
        _recv(_pay(5, id, 1, redeemer, fee));
        assertEq(vault.instantPaid(), fee);
        assertApproxEqAbs(tok.balanceOf(redeemer) * 1.32e18 / 1e18, fee, 2);

        bytes memory short = _pay(5, id, 2, redeemer, 0.9 ether);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.InsufficientTreasury.selector, 0.9 ether, 0));
        _recv(short);
        assertEq(vault.instantPaid(), fee, "nothing paid, nothing recorded");

        // The Treasury is refilled; the same message, delivered again, pays exactly once.
        tok.setRate(1.8e18);
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
        assertEq(vault.treasuryCredited(), amt);
        uint256 t = vault.treasuryBalance();
        vault.withdrawTreasury(t, address(0xC0FFEE));
        assertEq(vault.treasuryBalance(), 0);
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
            assertLt(g - gasleft(), 150_000, "well under 250,000");
        }
    }
}
