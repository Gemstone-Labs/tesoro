// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";
import {WstETHRateAdapter} from "../src/WstETHRateAdapter.sol";
import {RateToken} from "./MainnetVault.t.sol";

/// Real-LST vault (rate source, no yield minter) driven through random opens, rate moves from -10% to +5%
/// (slashes), funding, owner withdrawals of `treasuryBalance()`, Instant Redeems, PayYield to players and to the
/// vault, Unlocks and reports.
contract RealLstHandler is Test {
    uint32 constant CHAIN = 7;
    RateToken public tok;
    PositionVault public vault;
    MockEndpoint public ep;
    address public user = address(0xA11CE);
    address public redeemer = address(0xEDEE);

    uint64[] public ids;
    mapping(uint64 => uint64) public nextSeq;
    /// ghost: yield was paid out of this open Position (to a player or back to the vault) (audit E-1 exposure: a fall can erase it)
    mapping(uint64 => bool) public paidOut;
    bool public unlockShort;

    constructor() {
        tok = new RateToken();
        ep = new MockEndpoint();
        vault = new PositionVault(
            address(tok), address(new WstETHRateAdapter(address(tok))), address(ep), CHAIN, address(0)
        );
        tok.mint(user, type(uint128).max);
        vm.prank(user);
        tok.approve(address(vault), type(uint256).max);
        tok.approve(address(vault), type(uint256).max);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function open(uint256 amount, uint8 horizon) external {
        amount = bound(amount, 1e6, 3 ether);
        horizon = uint8(bound(horizon, 1, 12));
        vm.prank(user);
        try vault.openPosition(amount, horizon) returns (uint64 id) {
            ids.push(id);
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    /// -10% .. +5%, kept inside [0.3, 5].
    function moveRate(uint256 seed) external {
        uint256 bps = bound(seed, 9000, 10_500);
        uint256 r = tok.stEthPerToken() * bps / 10_000;
        tok.setRate(bound(r, 0.3e18, 5e18));
    }

    function fund(uint256 shares) external {
        shares = bound(shares, 1, 5 ether);
        tok.mint(address(this), shares);
        vault.fundTreasury(shares);
    }

    function withdraw(uint256 pct) external {
        uint256 t = vault.treasuryBalance() * bound(pct, 1, 100) / 100;
        if (t == 0) return;
        vault.withdrawTreasury(t, address(this));
    }

    function instant(uint256 idx, uint256 pct, bool overshoot) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 t = vault.treasuryBalance();
        uint256 amount = overshoot ? t + bound(pct, 1, 1 ether) : t * bound(pct, 0, 100) / 100;
        _deliver(abi.encode(uint8(5), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(redeemer))), amount));
    }

    function payYield(uint256 idx, uint256 pct, bool toVault) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 amount = vault.payableYield(id) * bound(pct, 0, 100) / 100;
        address to = toVault ? address(vault) : redeemer;
        bool ok = _deliver(abi.encode(uint8(4), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(to))), amount));
        // a refill to the vault moves the Position's shares out just like a payout to a player
        if (ok && amount > 0 && !vault.getPosition(id).unlocked) paidOut[id] = true;
    }

    function unlock(uint256 idx) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        PositionVault.Position memory p = vault.getPosition(id);
        if (p.unlocked) return;
        uint256 rate = tok.stEthPerToken();
        uint256 needed = (p.principalUnderlying * 1e18 + rate - 1) / rate;
        if (needed > p.principalShares) needed = p.principalShares;
        uint256 before = tok.balanceOf(user);
        bool ok = _deliver(abi.encode(uint8(3), CHAIN, id, ++nextSeq[id]));
        // I2: an Unlock returns the Principal in full unless a player was paid yield the rate has since erased.
        if (ok && !paidOut[id] && tok.balanceOf(user) - before < needed) unlockShort = true;
    }

    function report(uint256 idx) external {
        if (ids.length == 0) return;
        try vault.reportYield(ids[idx % ids.length]) {} catch {}
    }

    function _deliver(bytes memory m) internal returns (bool ok) {
        try ep.deliver(address(vault), m) {
            ok = true;
        } catch {}
    }

    /// I3: the owner withdrawing `treasuryBalance()` never makes a PayYield revert (open or unlocked Positions).
    function withdrawThenEveryClaimIsPayable() external returns (bool) {
        uint256 snap = vm.snapshotState();
        uint256 t = vault.treasuryBalance();
        if (t > 0) vault.withdrawTreasury(t, address(this));
        bool ok = true;
        for (uint256 i; i < ids.length; i++) {
            uint64 id = ids[i];
            uint256 amount = vault.payableYield(id);
            if (amount == 0) continue;
            ok = ok
                && _deliver(abi.encode(uint8(4), CHAIN, id, ++nextSeq[id], bytes32(uint256(uint160(redeemer))), amount));
        }
        vm.revertToState(snap);
        return ok;
    }
}

contract RealLstInvariantTest is Test {
    RealLstHandler h;

    function setUp() public {
        h = new RealLstHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = h.open.selector;
        sel[1] = h.warp.selector;
        sel[2] = h.moveRate.selector;
        sel[3] = h.fund.selector;
        sel[4] = h.withdraw.selector;
        sel[5] = h.instant.selector;
        sel[6] = h.payYield.selector;
        sel[7] = h.unlock.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// I1: the vault holds exactly what open Positions hold plus the Treasury.
    function invariant_I1_accounting() public view {
        PositionVault v = h.vault();
        uint256 held;
        uint256 owed;
        for (uint256 i; i < h.idsLength(); i++) {
            uint64 id = h.ids(i);
            PositionVault.Position memory p = v.getPosition(id);
            held += p.heldShares;
            owed += v.owedSharesOf(id);
            if (p.unlocked) assertEq(p.heldShares, 0);
        }
        assertEq(h.tok().balanceOf(address(v)), held + v.treasuryShares(), "balance = open held + T");
        assertEq(v.openHeldShares(), held);
        assertEq(v.owedShares(), owed);
        assertGe(v.treasuryShares(), v.owedShares(), "the Treasury always holds what it owes");
    }

    /// I2: Unlock returned the Principal in full whenever no player was paid yield the rate has since erased.
    function invariant_I2_principalAlwaysComesBack() public view {
        assertFalse(h.unlockShort());
    }

    /// I3: withdrawing the whole spendable Treasury never blocks a claim, open or unlocked.
    function invariant_I3_treasuryCannotHurtPlayers() public {
        assertTrue(h.withdrawThenEveryClaimIsPayable());
    }

    /// The spendable figure never exceeds what the Treasury's shares are worth.
    function invariant_spendableWithinT() public view {
        PositionVault v = h.vault();
        assertLe(v.spendableTreasuryShares(), v.treasuryShares());
        assertEq(v.poolOwedShares() + v.reservedShares(), 0);
    }
}
