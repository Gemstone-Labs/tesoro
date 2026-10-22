// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockEndpoint} from "../src/MockEndpoint.sol";

contract VaultHandler is Test {
    uint32 constant CHAIN = 7;
    SimLST public lst;
    PositionVault public vault;
    MockEndpoint public ep;
    address public user = address(0xA11CE);
    address public redeemer = address(0xEDEE);

    uint64[] public ids;
    mapping(uint64 => uint64) public maxSeqSeen; // ghost: highest inbound seq accepted per position
    mapping(uint64 => uint256) public ghostUnlockReleased; // shares that left to the owner
    uint256 public ghostSharesToRedeemer;
    uint256 public ghostOwnerReleasedTotal;
    bool public seqWentBackwards;
    bool public claimUnderpaid;
    uint256 public ghostFeesTaken; // fees named in PayYield messages that were applied

    constructor() {
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        ep = new MockEndpoint();
        vault = new PositionVault(address(lst), address(lst), address(ep), CHAIN, address(lst));
        lst.setMinter(address(vault));
        vm.prank(user);
        lst.approve(address(vault), type(uint256).max);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function open(uint256 amount, uint8 horizon) external {
        amount = bound(amount, 1e6, 18 ether); // Principal must fit u64
        horizon = uint8(bound(horizon, 1, 12));
        deal(address(lst), user, amount + lst.balanceOf(user)); // faucet-equivalent, simple mint via storage
        vm.prank(user);
        ids.push(vault.openPosition(amount, horizon));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    function report(uint256 idx) external {
        if (ids.length == 0) return;
        vault.reportYield(ids[idx % ids.length]);
    }

    function pay(uint256 idx, uint64 seq, uint256 amount, bool overshoot, uint8 feePct, uint8 poolPct) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 avail = vault.payableYield(id);
        amount = overshoot ? bound(amount, 0, avail * 2 + 1) : bound(amount, 0, avail);
        seq = uint64(bound(seq, 0, maxSeqSeen[id] + 3));
        uint256 fee = (amount * bound(feePct, 0, 100)) / 100;
        _pay(id, seq, amount, fee, (fee * bound(poolPct, 0, 100)) / 100);
    }

    function _pay(uint64 id, uint64 seq, uint256 amount, uint256 fee, uint256 pool) internal {
        uint64 before = vault.getPosition(id).inSeq;
        uint256 bal = lst.balanceOf(redeemer);
        uint256 paidBefore = vault.getPosition(id).paidUnderlying;
        bytes memory m = abi.encode(uint8(4), CHAIN, id, seq, bytes32(uint256(uint160(redeemer))), amount, fee, pool);
        try ep.deliver(address(vault), m) {} catch {}
        _track(id, before);
        uint256 got = lst.balanceOf(redeemer) - bal;
        ghostSharesToRedeemer += got;
        uint256 recorded = vault.getPosition(id).paidUnderlying - paidBefore;
        uint256 rate = lst.underlyingPerShare();
        uint256 feeTaken = recorded == amount && amount > 0 ? fee : 0;
        ghostFeesTaken += feeTaken;
        if (got * rate / 1e18 + rate / 1e18 + 1 < recorded - feeTaken) claimUnderpaid = true;
    }

    function unlock(uint256 idx, uint64 seq) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        seq = uint64(bound(seq, 0, maxSeqSeen[id] + 3));
        uint64 before = vault.getPosition(id).inSeq;
        uint256 bal = lst.balanceOf(user);
        try ep.deliver(address(vault), abi.encode(uint8(3), CHAIN, id, seq)) {} catch {}
        _track(id, before);
        uint256 got = lst.balanceOf(user) - bal;
        ghostUnlockReleased[id] += got;
        ghostOwnerReleasedTotal += got;
    }

    function _track(uint64 id, uint64 before) internal {
        uint64 afterSeq = vault.getPosition(id).inSeq;
        if (afterSeq < before) seqWentBackwards = true;
        if (afterSeq > maxSeqSeen[id]) maxSeqSeen[id] = afterSeq;
    }
}

contract PositionVaultInvariantTest is Test {
    VaultHandler h;

    function setUp() public {
        h = new VaultHandler();
        targetContract(address(h));
    }

    /// The vault always holds at least the shares of every open Principal: payouts mint, they never dip into it.
    function invariant_principalCoveredWhileLocked() public view {
        PositionVault v = h.vault();
        assertGe(h.lst().balanceOf(address(v)), v.openPrincipalUnderlying());
    }

    /// Paid yield never exceeds cumulative accrued yield.
    function invariant_paidNotAboveAccrued() public view {
        PositionVault v = h.vault();
        for (uint256 i = 0; i < h.idsLength(); i++) {
            uint64 id = h.ids(i);
            assertLe(v.getPosition(id).paidUnderlying, v.accruedYield(id));
        }
    }

    /// The Treasury only ever holds fees taken at cash-out (nothing is credited here): Treasury plus Instant
    /// payouts never exceed them, and the Pool's part is never more than the fees.
    function invariant_treasuryNeverAboveFeesTakenAtCashOut() public view {
        PositionVault v = h.vault();
        assertEq(v.realisedFees(), h.ghostFeesTaken());
        assertLe(v.treasuryBalance() + v.instantPaid() + v.poolOwedUnits(), v.realisedFees());
        assertLe(v.poolOwedUnits(), v.realisedFees());
    }

    /// A Position's locked shares can be released to its owner at most once, and only at Unlock.
    function invariant_principalReleasedOnlyViaUnlock() public view {
        PositionVault v = h.vault();
        for (uint256 i = 0; i < h.idsLength(); i++) {
            uint64 id = h.ids(i);
            PositionVault.Position memory p = v.getPosition(id);
            if (!p.unlocked) assertEq(h.ghostUnlockReleased(id), 0);
            assertLe(h.ghostUnlockReleased(id), p.principalShares);
        }
    }

    /// Every claim recorded as paid was paid in shares worth the claim (less than one share-wei of rounding).
    function invariant_claimsPaidInFull() public view {
        assertFalse(h.claimUnderpaid());
    }

    /// Highest inbound seq per position never decreases (each seq is processed at most once, in any order).
    function invariant_inboundSeqMonotonic() public view {
        assertFalse(h.seqWentBackwards());
    }
}

contract PositionVaultFuzzTest is Test {
    uint32 constant CHAIN = 7;

    /// A message applied twice changes state exactly as if applied once.
    function testFuzz_payYieldIdempotent(uint256 amount, uint256 elapsed) public {
        SimLST lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        MockEndpoint ep = new MockEndpoint();
        PositionVault vault = new PositionVault(address(lst), address(lst), address(ep), CHAIN, address(lst));
        lst.setMinter(address(vault));
        address alice = address(0xA11CE);
        lst.faucet(alice);
        vm.prank(alice);
        lst.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        uint64 id = vault.openPosition(10 ether, 6);

        vm.warp(block.timestamp + bound(elapsed, 1, 2 hours));
        amount = bound(amount, 0, vault.payableYield(id));
        bytes memory m = abi.encode(
            uint8(4), CHAIN, id, uint64(1), bytes32(uint256(uint160(address(0xBEEF)))), amount, uint256(0), uint256(0)
        );
        ep.deliver(address(vault), m);
        uint256 paid = vault.getPosition(id).paidUnderlying;
        uint256 bal = lst.balanceOf(address(0xBEEF));
        ep.deliver(address(vault), m);
        assertEq(vault.getPosition(id).paidUnderlying, paid);
        assertEq(lst.balanceOf(address(0xBEEF)), bal);
    }

    function testFuzz_simRateMonotonicAcrossParamChanges(uint16 apy, uint16 speed, uint32 dt1, uint32 dt2) public {
        SimLST lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        vm.warp(block.timestamp + dt1);
        uint256 r1 = lst.underlyingPerShare();
        lst.setRateParams(apy, speed);
        assertEq(lst.underlyingPerShare(), r1);
        vm.warp(block.timestamp + dt2);
        assertGe(lst.underlyingPerShare(), r1);
    }
}
