// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {SimLST} from "../src/SimLST.sol";
import {PositionVaultBase} from "../src/PositionVaultBase.sol";
import {PositionVaultOApp} from "../src/PositionVaultOApp.sol";
import {MockLzEndpoint} from "./PositionVaultOApp.t.sol";

/// @notice Handler-based stateful fuzzer for `PositionVaultOApp` over the real LayerZero V2 packed wire format.
///         Exercises interleaved deposits, rate-param/time yield ticks, yield reports, treasury funding/withdrawals,
///         delivery-fee updates, escrow funding, inbound `lzReceive` messages (UnlockV2, PayYieldV2, PayInstantV2,
///         CashInBatch, PayPrizeV2), explicit replays, ack resends, and unauthorized/malformed peer attacks.
contract PositionVaultOAppHandler is Test {
    uint32 public constant HOODI_EID = 40449;
    uint32 public constant SOLANA_EID = 40168;
    bytes32 public constant SOLANA_PEER = bytes32(uint256(0x501A4A00BEEF));
    bytes32 public constant ROGUE_PEER = bytes32(uint256(0xBAD00000DEAD));

    MockLzEndpoint public ep;
    SimLST public lst;
    PositionVaultOApp public vault;

    address public user = address(0xA11CE);
    address public redeemer = address(0xEDEE);
    address public feeCollector = address(0x7E50);
    address public keeper = address(0x4EE9);
    address public prizeWinner = address(0x1111);

    uint64[] public ids;
    mapping(uint64 => uint64) public lastOutSeq;
    mapping(uint64 => uint64) public maxInSeq;
    mapping(uint64 => uint256) public lastReportedAccrued;
    mapping(uint64 => uint256) public ghostUnlockReleased;
    mapping(uint64 => uint64[]) internal _handledSeqs;
    mapping(uint64 => mapping(uint64 => bytes)) internal _handledWire;

    uint64 public nextBatchId;
    uint64 public nextPayoutId;
    mapping(uint64 => bytes) internal _payoutWire;

    uint256 public ghostDepositedPrincipal;
    uint256 public ghostTotalPrincipalReleased;
    uint256 public ghostFeesTaken;
    uint256 public ghostTotalYieldPaidToUsers;
    uint256 public ghostTotalBatchWalletPaid;
    uint256 public ghostTotalBatchEscrowUnits;
    uint256 public ghostPrizeSharesPaid;
    uint256 public lastEscrowedShares;
    uint256 public lastEscrowedUnits;

    bool public outSeqWentBackwards;
    bool public inSeqWentBackwards;
    bool public reportedAccruedFell;
    bool public replayMutatedState;
    bool public unauthorizedMutated;
    bool public batchOverpaid;
    bool public escrowCounterFell;
    bool public deliveryFeeExceededCap;

    receive() external payable {}

    constructor() {
        ep = new MockLzEndpoint();
        lst = new SimLST(address(this), "Simulated Staked ETH", "simETH");
        vault = new PositionVaultOApp(
            address(lst), address(lst), address(ep), HOODI_EID, SOLANA_EID, address(this), address(lst)
        );
        lst.setMinter(address(vault));
        vault.setPeer(SOLANA_EID, SOLANA_PEER);
        vault.setEscrowKeeper(keeper);
        vault.setDelivery(feeCollector, 0.05 ether);

        vm.deal(address(this), 100 ether);
        vm.deal(user, 100 ether);
        vm.deal(address(vault), 1 ether);

        vm.prank(user);
        lst.approve(address(vault), type(uint256).max);
        lst.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    // ------------------------------------------------------------------ wire helpers

    function _vaultKey() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(vault))) << 96);
    }

    function _posKey(uint64 id) internal view returns (bytes32) {
        return bytes32((uint256(uint160(address(vault))) << 96) | (uint256(id) << 32));
    }

    function _deliverWire(bytes memory message) internal returns (bool ok) {
        vm.prank(address(ep));
        try vault.lzReceive(Origin(SOLANA_EID, SOLANA_PEER, 1), bytes32(0), message, address(0), "") {
            ok = true;
        } catch {}
    }

    function _stateDigest(uint64 id) internal view returns (bytes32) {
        PositionVaultBase.Position memory p = vault.getPosition(id);
        bytes32 bals = keccak256(
            abi.encode(
                lst.balanceOf(address(vault)),
                lst.balanceOf(user),
                lst.balanceOf(redeemer),
                lst.balanceOf(feeCollector),
                lst.balanceOf(prizeWinner),
                vault.openPrincipalUnderlying(),
                vault.realisedFees(),
                vault.treasuryCredited()
            )
        );
        return keccak256(
            abi.encode(
                bals,
                vault.treasuryWithdrawn(),
                vault.instantPaid(),
                vault.poolAccruedUnits(),
                vault.escrowShares(),
                vault.escrowedShares(),
                vault.escrowedUnits(),
                p.paidUnderlying,
                p.inSeq,
                p.unlocked
            )
        );
    }

    function _trackInSeq(uint64 id, uint64 before) internal {
        uint64 afterSeq = vault.getPosition(id).inSeq;
        if (afterSeq < before) inSeqWentBackwards = true;
        if (afterSeq > maxInSeq[id]) maxInSeq[id] = afterSeq;
    }

    function _trackEscrow() internal {
        if (vault.escrowedShares() < lastEscrowedShares || vault.escrowedUnits() < lastEscrowedUnits) {
            escrowCounterFell = true;
        }
        lastEscrowedShares = vault.escrowedShares();
        lastEscrowedUnits = vault.escrowedUnits();
    }

    function _checkDeliveryCap(uint256 feePaid, uint256 requestedFee, uint256 grossPayout) internal {
        address recip = vault.deliveryRecipient();
        if (recip == address(0)) {
            if (feePaid != 0) deliveryFeeExceededCap = true;
            return;
        }
        uint256 cap = requestedFee < vault.maxDeliveryFee() ? requestedFee : vault.maxDeliveryFee();
        uint256 tenth = (grossPayout * 1_000) / 10_000;
        if (cap > tenth) cap = tenth;
        if (feePaid > cap) deliveryFeeExceededCap = true;
    }

    // ------------------------------------------------------------------ deposits & yield ticks

    function open(uint256 amount, uint8 horizon, bool useOpenFor) external {
        if (ids.length >= 16) return;
        amount = bound(amount, 1e9, 10 ether);
        horizon = uint8(bound(horizon, 1, 12));
        uint256 fee = vault.quotePositionLocked();
        deal(address(lst), user, lst.balanceOf(user) + amount);
        vm.deal(user, user.balance + fee + 0.001 ether);

        vm.prank(user);
        uint64 id = useOpenFor
            ? vault.openPositionFor{value: fee + 0.0005 ether}(user, amount, horizon)
            : vault.openPosition{value: fee}(amount, horizon);

        ids.push(id);
        uint64 outSeq = vault.getPosition(id).outSeq;
        if (outSeq <= lastOutSeq[id]) outSeqWentBackwards = true;
        lastOutSeq[id] = outSeq;
        ghostDepositedPrincipal += vault.getPosition(id).principalUnderlying;
    }

    function warpAndTickRate(uint256 secs, uint256 newApy, uint256 newSpeedup, bool updateParams) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
        if (updateParams) {
            lst.setRateParams(bound(newApy, 100, 1_500), bound(newSpeedup, 1, 4_380));
        }
    }

    function sendYieldReport(uint256 idx) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint64 beforeOut = vault.getPosition(id).outSeq;
        uint256 beforeRep = vault.reportedAccrued(id);
        uint256 fee = vault.quoteYieldAccrued();
        vm.deal(address(this), address(this).balance + fee);
        vault.reportYield{value: fee}(id);

        uint64 afterOut = vault.getPosition(id).outSeq;
        if (afterOut <= beforeOut || afterOut <= lastOutSeq[id]) outSeqWentBackwards = true;
        lastOutSeq[id] = afterOut;

        uint256 afterRep = vault.reportedAccrued(id);
        if (afterRep < beforeRep || afterRep < lastReportedAccrued[id]) reportedAccruedFell = true;
        lastReportedAccrued[id] = afterRep;
    }

    // ------------------------------------------------------------------ treasury & admin

    function fundTreasury(uint256 shares) external {
        shares = bound(shares, 1e9, 5 ether);
        deal(address(lst), address(this), lst.balanceOf(address(this)) + shares);
        vault.fundTreasury(shares);
    }

    function withdrawTreasury(uint256 pct) external {
        uint256 avail = vault.treasuryBalance();
        if (avail == 0) return;
        uint256 amount = (avail * bound(pct, 1, 100)) / 100;
        if (amount == 0) return;
        vault.withdrawTreasury(amount, address(this));
    }

    function fundPrizeEscrow(uint256 pct, bool asKeeper) external {
        uint256 owed = vault.poolOwedUnits();
        if (owed == 0) return;
        uint256 req = pct % 3 == 0 ? 0 : (owed * bound(pct, 1, 100)) / 100;
        if (asKeeper) vm.prank(keeper);
        try vault.fundPrizeEscrow(req) {} catch {}
        _trackEscrow();
    }

    function updateAdminConfig(bool enableDelivery, uint256 maxFee, uint128 cu, bool drainVaultEth) external {
        address recip = enableDelivery ? feeCollector : address(0);
        vault.setDelivery(recip, bound(maxFee, 0, 1 ether));
        vault.setSolanaReceiveCu(uint128(bound(cu, 50_000, 500_000)));
        if (drainVaultEth && address(vault).balance > 0) {
            vault.withdrawNative(payable(address(this)), address(vault).balance);
        } else if (!drainVaultEth) {
            vm.deal(address(vault), 0.5 ether);
        }
    }

    // ------------------------------------------------------------------ inbound lzReceive

    function lzUnlock(uint256 idx, uint64 seqOffset, uint128 deliveryFee) external returns (bool ok) {
        if (ids.length == 0) return false;
        uint64 id = ids[idx % ids.length];
        uint64 seq = maxInSeq[id] + uint64(bound(seqOffset, 1, 5));
        deliveryFee = uint128(bound(deliveryFee, 0, 2 ether));

        uint64 beforeSeq = vault.getPosition(id).inSeq;
        bool wasUnlocked = vault.getPosition(id).unlocked;
        uint256 userBefore = lst.balanceOf(user);
        uint256 feeBefore = lst.balanceOf(feeCollector);

        bytes memory wire = abi.encodePacked(uint8(10), HOODI_EID, _posKey(id), seq, deliveryFee);
        ok = _deliverWire(wire);
        _trackInSeq(id, beforeSeq);

        if (ok) {
            _handledSeqs[id].push(seq);
            _handledWire[id][seq] = wire;
            uint256 userGot = lst.balanceOf(user) - userBefore;
            uint256 feeGot = lst.balanceOf(feeCollector) - feeBefore;
            uint256 released = userGot + feeGot;
            ghostUnlockReleased[id] += released;
            ghostTotalPrincipalReleased += released;
            if (!wasUnlocked && vault.getPosition(id).unlocked) {
                _checkDeliveryCap(feeGot, deliveryFee, vault.getPosition(id).principalUnderlying);
            } else if (wasUnlocked && released != 0) {
                replayMutatedState = true;
            }
        }
    }

    struct PayYieldArgs {
        uint64 id;
        uint64 seq;
        address to;
        bool toVault;
        uint128 amount;
        uint128 fee;
        uint128 pool;
        uint128 deliveryFee;
    }

    function lzPayYield(
        uint256 idx,
        uint64 seqOffset,
        uint256 pct,
        bool overshoot,
        bool toVault,
        uint8 feePct,
        uint8 poolPct,
        uint128 deliveryFee
    ) external returns (bool) {
        if (ids.length == 0) return false;
        PayYieldArgs memory a;
        a.id = ids[idx % ids.length];
        a.seq = maxInSeq[a.id] + uint64(bound(seqOffset, 1, 5));
        a.to = toVault ? address(vault) : redeemer;
        a.toVault = toVault;
        a.deliveryFee = uint128(bound(deliveryFee, 0, 1 ether));

        uint256 avail = vault.unreservedYield(a.id);
        uint256 amount = overshoot ? bound(pct, avail + 1, avail * 2 + 100) : (avail * bound(pct, 0, 100)) / 100;
        if (amount > type(uint128).max) amount = type(uint128).max;
        a.amount = uint128(amount);
        a.fee = uint128((amount * bound(feePct, 0, 50)) / 100);
        a.pool = uint128(((toVault ? amount : uint256(a.fee)) * bound(poolPct, 0, 100)) / 100);

        return _execPayYield(a);
    }

    function _execPayYield(PayYieldArgs memory a) internal returns (bool ok) {
        uint64 beforeSeq = vault.getPosition(a.id).inSeq;
        uint256 paidBefore = vault.getPosition(a.id).paidUnderlying;
        uint256 feeBefore = lst.balanceOf(feeCollector);
        uint256 redBefore = lst.balanceOf(redeemer);

        bytes memory wire = abi.encodePacked(
            uint8(11),
            HOODI_EID,
            _posKey(a.id),
            a.seq,
            bytes32(uint256(uint160(a.to))),
            a.amount,
            a.fee,
            a.pool,
            a.deliveryFee
        );
        ok = _deliverWire(wire);
        _trackInSeq(a.id, beforeSeq);

        if (ok) {
            _handledSeqs[a.id].push(a.seq);
            _handledWire[a.id][a.seq] = wire;
            uint256 paidDelta = vault.getPosition(a.id).paidUnderlying - paidBefore;
            if (!a.toVault && paidDelta == a.amount && a.amount > 0) {
                ghostFeesTaken += a.fee;
                uint256 feeGot = lst.balanceOf(feeCollector) - feeBefore;
                uint256 redGot = lst.balanceOf(redeemer) - redBefore;
                ghostTotalYieldPaidToUsers += redGot + feeGot;
                _checkDeliveryCap(feeGot, a.deliveryFee, a.amount - a.fee);
            }
        }
    }

    function lzPayInstant(uint256 idx, uint64 seqOffset, uint256 pct, bool overshoot, uint128 deliveryFee)
        external
        returns (bool ok)
    {
        if (ids.length == 0) return false;
        uint64 id = ids[idx % ids.length];
        uint256 avail = vault.treasuryBalance();
        uint256 amount = overshoot ? avail + bound(pct, 1, 1 ether) : (avail * bound(pct, 0, 100)) / 100;
        if (amount > type(uint128).max) amount = type(uint128).max;
        uint64 seq = maxInSeq[id] + uint64(bound(seqOffset, 1, 5));
        deliveryFee = uint128(bound(deliveryFee, 0, 1 ether));

        uint64 beforeSeq = vault.getPosition(id).inSeq;
        uint256 feeBefore = lst.balanceOf(feeCollector);

        bytes memory wire = abi.encodePacked(
            uint8(12), HOODI_EID, _posKey(id), seq, bytes32(uint256(uint160(redeemer))), uint128(amount), deliveryFee
        );
        ok = _deliverWire(wire);
        _trackInSeq(id, beforeSeq);

        if (ok) {
            _handledSeqs[id].push(seq);
            _handledWire[id][seq] = wire;
            uint256 feeGot = lst.balanceOf(feeCollector) - feeBefore;
            _checkDeliveryCap(feeGot, deliveryFee, amount);
        }
    }

    function lzCashInBatch(uint256 seed, uint256 pct, bool redeliver, bool tamper) external returns (bool ok) {
        if (ids.length == 0) return false;
        uint64 batchId = redeliver && nextBatchId > 0 ? uint64(bound(seed, 1, nextBatchId)) : ++nextBatchId;

        if (redeliver && batchId != nextBatchId) {
            (bool exists, uint8 bkind, bytes32 recipient, PositionVaultBase.BatchEntry[] memory es) =
                vault.batchOf(batchId);
            if (!exists) return false;

            bytes memory wire = abi.encodePacked(
                uint8(6), HOODI_EID, _vaultKey(), batchId, tamper ? uint8((bkind + 1) % 3) : bkind, recipient, uint8(es.length)
            );
            for (uint256 i; i < es.length; i++) {
                wire = abi.encodePacked(wire, es[i].positionId, es[i].requested);
            }

            bytes32 beforeDigest = _stateDigest(es[0].positionId);
            uint256 redBefore = lst.balanceOf(redeemer);
            uint256 escUnitsBefore = vault.escrowedUnits();
            ok = _deliverWire(wire);
            if (tamper && _stateDigest(es[0].positionId) != beforeDigest) {
                replayMutatedState = true;
            }
            if (!tamper) {
                ghostTotalBatchWalletPaid += lst.balanceOf(redeemer) - redBefore;
                ghostTotalBatchEscrowUnits += vault.escrowedUnits() - escUnitsBefore;
            }
            _checkBatch(batchId);
            _trackEscrow();
            return ok;
        }

        uint256 n = bound(seed >> 8, 1, 3);
        uint8 kind = uint8((seed >> 16) % 3);
        bytes32 to = kind == 2 ? bytes32(0) : bytes32(uint256(uint160(redeemer)));
        bytes memory msgWire = abi.encodePacked(uint8(6), HOODI_EID, _vaultKey(), batchId, kind, to, uint8(n));
        for (uint256 i; i < n; i++) {
            uint64 pid = ids[uint256(keccak256(abi.encode(seed, i))) % ids.length];
            uint128 req = uint128((vault.payableYield(pid) * bound(pct, 0, 150)) / 100 + (seed % 5));
            msgWire = abi.encodePacked(msgWire, pid, req);
        }

        uint256 redBeforeNew = lst.balanceOf(redeemer);
        uint256 escUnitsBeforeNew = vault.escrowedUnits();
        ok = _deliverWire(msgWire);
        ghostTotalBatchWalletPaid += lst.balanceOf(redeemer) - redBeforeNew;
        ghostTotalBatchEscrowUnits += vault.escrowedUnits() - escUnitsBeforeNew;
        _checkBatch(batchId);
        _trackEscrow();
    }

    function _checkBatch(uint64 batchId) internal {
        (,,, PositionVaultBase.BatchEntry[] memory es) = vault.batchOf(batchId);
        for (uint256 i; i < es.length; i++) {
            if (es[i].paid > es[i].requested) batchOverpaid = true;
        }
    }

    function lzPayPrize(uint256 pct, bool overshoot, uint128 deliveryFee) external returns (bool ok) {
        uint256 esc = vault.escrowShares();
        uint128 shares = overshoot
            ? uint128(esc + bound(pct, 1, 1 ether))
            : uint128((esc * bound(pct, 0, 100)) / 100);
        deliveryFee = uint128(bound(deliveryFee, 0, 1 ether));
        uint64 payoutId = ++nextPayoutId;

        bytes memory wire = abi.encodePacked(
            uint8(13),
            HOODI_EID,
            _vaultKey(),
            payoutId,
            bytes32(uint256(uint160(address(lst)))),
            bytes32(uint256(0x9A17E)),
            bytes32(uint256(uint160(prizeWinner))),
            shares,
            deliveryFee
        );

        uint256 escBefore = vault.escrowShares();
        uint256 feeBefore = lst.balanceOf(feeCollector);
        ok = _deliverWire(wire);
        if (ok) {
            _payoutWire[payoutId] = wire;
            uint256 paid = escBefore - vault.escrowShares();
            ghostPrizeSharesPaid += paid;
            if (paid > 0) {
                uint256 feeGot = lst.balanceOf(feeCollector) - feeBefore;
                _checkDeliveryCap(feeGot, deliveryFee, paid);
            }
        }
        _trackEscrow();
    }

    // ------------------------------------------------------------------ explicit replay & resend

    function replayHandledMessage(uint256 idx, uint256 seqPick) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint256 len = _handledSeqs[id].length;
        if (len == 0) return;
        uint64 seq = _handledSeqs[id][seqPick % len];
        bytes memory wire = _handledWire[id][seq];
        if (wire.length == 0) return;

        bytes32 before = _stateDigest(id);
        _deliverWire(wire);
        if (_stateDigest(id) != before) replayMutatedState = true;
    }

    function replayPrizePayout(uint256 pick) external {
        if (nextPayoutId == 0) return;
        uint64 payoutId = uint64(bound(pick, 1, nextPayoutId));
        bytes memory wire = _payoutWire[payoutId];
        if (wire.length == 0) return;

        uint64 refId = ids.length > 0 ? ids[0] : 0;
        bytes32 before = _stateDigest(refId);
        _deliverWire(wire);
        if (_stateDigest(refId) != before) replayMutatedState = true;
    }

    function resendAck(uint256 pick, bool isPrize) external {
        if (isPrize) {
            if (nextPayoutId == 0) return;
            uint64 payoutId = uint64(bound(pick, 1, nextPayoutId));
            uint256 fee = vault.quotePayPrizeResult();
            vm.deal(address(this), address(this).balance + fee);
            try vault.resendPayPrizeResult{value: fee}(payoutId) {} catch {}
        } else {
            if (nextBatchId == 0) return;
            uint64 batchId = uint64(bound(pick, 1, nextBatchId));
            (bool exists,,, PositionVaultBase.BatchEntry[] memory es) = vault.batchOf(batchId);
            if (!exists) return;
            uint256 fee = vault.quoteBatchResult(uint8(es.length));
            vm.deal(address(this), address(this).balance + fee);
            try vault.resendBatchResult{value: fee}(batchId) {} catch {}
        }
    }

    // ------------------------------------------------------------------ adversarial unauthorized attempts

    function attemptUnauthorizedLzReceive(uint256 idx, uint8 attackKind) external {
        if (ids.length == 0) return;
        uint64 id = ids[idx % ids.length];
        uint64 freshSeq = maxInSeq[id] + 100;
        bytes32 before = _stateDigest(id);

        uint8 kind = attackKind % 7;
        bytes memory validUnlock = abi.encodePacked(uint8(10), HOODI_EID, _posKey(id), freshSeq, uint128(0));

        if (kind == 0) {
            // Wrong caller (not endpoint)
            vm.prank(user);
            try vault.lzReceive(Origin(SOLANA_EID, SOLANA_PEER, 1), bytes32(0), validUnlock, address(0), "") {} catch {}
        } else if (kind == 1) {
            // Wrong peer on authorized EID
            vm.prank(address(ep));
            try vault.lzReceive(Origin(SOLANA_EID, ROGUE_PEER, 1), bytes32(0), validUnlock, address(0), "") {} catch {}
        } else if (kind == 2) {
            // Wrong source EID
            vm.prank(address(ep));
            try vault.lzReceive(Origin(SOLANA_EID + 1, SOLANA_PEER, 1), bytes32(0), validUnlock, address(0), "") {}
            catch {}
        } else if (kind == 3) {
            // Wrong vault key
            bytes32 foreignKey = bytes32((uint256(uint160(address(0xDEAD))) << 96) | (uint256(id) << 32));
            bytes memory foreignMsg = abi.encodePacked(uint8(10), HOODI_EID, foreignKey, freshSeq, uint128(0));
            _deliverWire(foreignMsg);
        } else if (kind == 4) {
            // Dirty low 32 bits in position key
            bytes32 dirtyKey = bytes32(uint256(_posKey(id)) | 1);
            bytes memory dirtyMsg = abi.encodePacked(uint8(10), HOODI_EID, dirtyKey, freshSeq, uint128(0));
            _deliverWire(dirtyMsg);
        } else if (kind == 5) {
            // Wide recipient word (> 160 bits) on PayYield
            bytes32 wide = bytes32(uint256(uint160(redeemer)) | (uint256(1) << 200));
            bytes memory badRecip = abi.encodePacked(
                uint8(11), HOODI_EID, _posKey(id), freshSeq, wide, uint128(1), uint128(0), uint128(0), uint128(0)
            );
            _deliverWire(badRecip);
        } else {
            // Wrong chain id in header
            bytes memory wrongChain = abi.encodePacked(uint8(10), HOODI_EID + 1, _posKey(id), freshSeq, uint128(0));
            _deliverWire(wrongChain);
        }

        if (_stateDigest(id) != before) unauthorizedMutated = true;
    }
}

contract PositionVaultOAppInvariantTest is Test {
    PositionVaultOAppHandler public h;

    function setUp() public {
        h = new PositionVaultOAppHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = h.open.selector;
        sel[1] = h.warpAndTickRate.selector;
        sel[2] = h.sendYieldReport.selector;
        sel[3] = h.fundTreasury.selector;
        sel[4] = h.withdrawTreasury.selector;
        sel[5] = h.fundPrizeEscrow.selector;
        sel[6] = h.updateAdminConfig.selector;
        sel[7] = h.lzUnlock.selector;
        sel[8] = h.lzPayYield.selector;
        sel[9] = h.lzPayInstant.selector;
        sel[10] = h.lzCashInBatch.selector;
        sel[11] = h.lzPayPrize.selector;
        sel[12] = h.replayHandledMessage.selector;
        sel[13] = h.replayPrizePayout.selector;
        sel[14] = h.resendAck.selector;
        sel[15] = h.attemptUnauthorizedLzReceive.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// 1. Vault LST solvency: vault LST balance always covers all open principal shares plus escrowed prize shares.
    function invariant_vaultSolvency() public view {
        PositionVaultOApp v = h.vault();
        uint256 openSum;
        for (uint256 i; i < h.idsLength(); i++) {
            PositionVaultBase.Position memory p = v.getPosition(h.ids(i));
            if (!p.unlocked) openSum += p.principalUnderlying;
        }
        assertEq(v.openPrincipalUnderlying(), openSum, "openPrincipalUnderlying matches unlocked sum");
        assertGe(
            h.lst().balanceOf(address(v)),
            v.openPrincipalUnderlying() + v.escrowShares(),
            "vault LST balance covers open principal + prize escrow"
        );
    }

    /// 2. Sequence monotonicity & replay rejection: outSeq/inSeq never regress and replaying handled messages or prize
    ///    payouts / tampered batches never mutates state or double-pays.
    function invariant_seqMonotonicAndReplaySafe() public view {
        assertFalse(h.outSeqWentBackwards(), "outbound seq must strictly grow");
        assertFalse(h.inSeqWentBackwards(), "inbound high-water seq must never fall");
        assertFalse(h.reportedAccruedFell(), "reportedAccrued high-water mark must never fall");
        assertFalse(h.replayMutatedState(), "replayed or tampered inbound message mutated state");
    }

    /// 3. Unauthorized peer / wrong EID / wrong endpoint / wrong vault key messages never mutate vault state.
    function invariant_unauthorizedNeverMutatesState() public view {
        assertFalse(h.unauthorizedMutated(), "unauthorized lzReceive mutated state");
    }

    /// 4. Principal & yield conservation: unlocked principal + remaining open principal equals deposited principal;
    ///    paid yield never exceeds cumulative accrued yield; principal is released at most once and only via unlock.
    function invariant_principalAndYieldConservation() public view {
        PositionVaultOApp v = h.vault();
        uint256 totalAccrued;
        for (uint256 i; i < h.idsLength(); i++) {
            uint64 id = h.ids(i);
            PositionVaultBase.Position memory p = v.getPosition(id);
            uint256 acc = v.accruedYield(id);
            totalAccrued += acc;
            assertLe(p.paidUnderlying, acc, "paid yield cannot exceed accrued yield");
            if (!p.unlocked) assertEq(h.ghostUnlockReleased(id), 0, "locked principal cannot be released");
            assertLe(h.ghostUnlockReleased(id), p.principalShares, "principal cannot be released twice");
        }
        assertEq(
            h.ghostTotalPrincipalReleased() + v.openPrincipalUnderlying(),
            h.ghostDepositedPrincipal(),
            "released + locked principal == deposited principal"
        );
        assertLe(
            h.ghostTotalPrincipalReleased() + v.openPrincipalUnderlying() + h.ghostTotalYieldPaidToUsers()
                + h.ghostTotalBatchWalletPaid() + h.ghostTotalBatchEscrowUnits() + v.realisedFees(),
            h.ghostDepositedPrincipal() + totalAccrued,
            "total payouts + locked principal <= deposited principal + realized yield"
        );
    }

    /// 5. Treasury, batch, and prize escrow conservation.
    function invariant_treasuryBatchAndEscrowConservation() public view {
        PositionVaultOApp v = h.vault();
        assertEq(v.realisedFees(), h.ghostFeesTaken(), "realisedFees matches applied PayYield fees");
        assertEq(
            v.treasuryBalance() + v.treasuryWithdrawn() + v.instantPaid() + v.poolAccruedUnits(),
            v.realisedFees() + v.treasuryCredited(),
            "treasury conservation identity"
        );
        assertEq(v.escrowedShares() - h.ghostPrizeSharesPaid(), v.escrowShares(), "escrow in - paid == live escrow");
        assertFalse(h.escrowCounterFell(), "escrow cumulative counters must be monotonic");
        assertFalse(h.batchOverpaid(), "batch entry paid must never exceed requested");
    }

    /// 6. Delivery fee cap: fee deducted on any payout never exceeds min(requested, maxDeliveryFee, 10% of payout).
    function invariant_deliveryFeeBounded() public view {
        assertFalse(h.deliveryFeeExceededCap(), "delivery fee exceeded cap or 10% ceiling");
    }

    /// 7. Positive & negative control on the exact same handler (`_deliverWire` / handler delivery functions):
    ///    proves that valid UnlockV2, PayYieldV2 (holder + vault refill), PayInstantV2, CashInBatch
    ///    (wallet + prize escrow), and PayPrizeV2 deliveries actually succeed, advance `inSeq`, and move
    ///    exact LST/treasury/escrow/user balances on-chain — so any silent drop in `_deliverWire` fails
    ///    this test immediately — while unauthorized, replayed, and tampered messages fail or are ignored.
    function test_positiveControl_inboundDeliveriesAdvanceSeqAndMoveBalances() public {
        // Setup: open 4 simETH position, warp 2 hours (1 simulated year at 4,380x => 0.2 simETH yield), fund treasury 2 simETH.
        h.open(4 ether, 6, false);
        assertEq(h.idsLength(), 1, "position opened");
        uint64 id = h.ids(0);
        assertEq(h.vault().openPrincipalUnderlying(), 4 ether, "open principal matches deposit");
        h.warpAndTickRate(2 hours, 0, 0, false);
        assertGt(h.vault().accruedYield(id), 0.1 ether, "yield accrued after warp");
        h.fundTreasury(2 ether);
        assertEq(h.vault().treasuryBalance(), 2 ether, "treasury funded");

        _assertPayYieldPositive(id);
        _assertPayInstantPositive(id);
        _assertCashInBatchPositive(id);
        _assertPayPrizePositive();
        _assertUnlockPositive(id);
        _assertNegativeControls(id);

        // All invariants must also hold after the full positive + negative control lifecycle.
        invariant_vaultSolvency();
        invariant_seqMonotonicAndReplaySafe();
        invariant_unauthorizedNeverMutatesState();
        invariant_principalAndYieldConservation();
        invariant_treasuryBatchAndEscrowConservation();
        invariant_deliveryFeeBounded();
    }

    function _assertPayYieldPositive(uint64 id) internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();

        // 1a) PayYieldV2 to holder (20% of avail, 20% fee, 50% of fee to pool, 0.001 ether delivery fee).
        {
            uint256 amt = (v.unreservedYield(id) * 20) / 100;
            uint256 fee = (amt * 20) / 100;
            uint256 pool = (fee * 50) / 100;
            uint256 redBefore = lst.balanceOf(h.redeemer());
            uint256 feeBefore = lst.balanceOf(h.feeCollector());

            assertTrue(h.lzPayYield(0, 1, 20, false, false, 20, 50, 0.001 ether), "PayYieldV2 holder must succeed");
            assertEq(v.getPosition(id).inSeq, 1, "PayYieldV2 must advance inSeq to 1");
            assertEq(v.getPosition(id).paidUnderlying, amt, "PayYieldV2 paidUnderlying delta");
            assertEq(v.realisedFees(), fee, "PayYieldV2 realisedFees delta");
            assertEq(v.poolAccruedUnits(), pool, "PayYieldV2 poolAccruedUnits delta");
            assertEq(lst.balanceOf(h.feeCollector()) - feeBefore, 0.001 ether, "PayYieldV2 delivery fee delta");
            assertEq(lst.balanceOf(h.redeemer()) - redBefore, amt - fee - 0.001 ether, "PayYieldV2 redeemer net delta");
        }

        // 1b) PayYieldV2 refill to vault (10% of remaining unreserved yield, 50% to pool).
        {
            uint256 amt = (v.unreservedYield(id) * 10) / 100;
            uint256 pool = (amt * 50) / 100;
            uint256 paidBefore = v.getPosition(id).paidUnderlying;
            uint256 credBefore = v.treasuryCredited();
            uint256 poolBefore = v.poolAccruedUnits();

            assertTrue(h.lzPayYield(0, 1, 10, false, true, 0, 50, 0), "PayYieldV2 refill must succeed");
            assertEq(v.getPosition(id).inSeq, 2, "PayYieldV2 refill must advance inSeq to 2");
            assertEq(v.getPosition(id).paidUnderlying - paidBefore, amt, "refill paidUnderlying delta");
            assertEq(v.treasuryCredited() - credBefore, amt, "refill treasuryCredited delta");
            assertEq(v.poolAccruedUnits() - poolBefore, pool, "refill poolAccruedUnits delta");
        }
    }

    function _assertPayInstantPositive(uint64 id) internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();
        uint256 treasBefore = v.treasuryBalance();
        uint256 amt = (treasBefore * 25) / 100;
        uint256 instantBefore = v.instantPaid();
        uint256 redBefore = lst.balanceOf(h.redeemer());
        uint256 feeBefore = lst.balanceOf(h.feeCollector());

        assertTrue(h.lzPayInstant(0, 1, 25, false, 0.001 ether), "PayInstantV2 delivery must succeed");
        assertEq(v.getPosition(id).inSeq, 3, "PayInstantV2 must advance inSeq to 3");
        assertEq(v.instantPaid() - instantBefore, amt, "PayInstantV2 instantPaid delta");
        assertEq(treasBefore - v.treasuryBalance(), amt, "PayInstantV2 treasuryBalance drop");
        assertEq(lst.balanceOf(h.feeCollector()) - feeBefore, 0.001 ether, "PayInstantV2 delivery fee delta");
        assertEq(lst.balanceOf(h.redeemer()) - redBefore, amt - 0.001 ether, "PayInstantV2 redeemer net delta");
    }

    function _assertCashInBatchPositive(uint64 id) internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();

        // CashInBatch kind = 0 (Platform wallet payout, n = 1, 10% of payableYield).
        {
            uint256 seed = (uint256(0) << 16) | (uint256(1) << 8);
            uint256 req = (v.payableYield(id) * 10) / 100 + (seed % 5);
            uint256 redBefore = lst.balanceOf(h.redeemer());
            uint256 paidBefore = v.getPosition(id).paidUnderlying;

            assertTrue(h.lzCashInBatch(seed, 10, false, false), "CashInBatch wallet delivery must succeed");
            (bool exists, uint8 bkind,, PositionVaultBase.BatchEntry[] memory es) = v.batchOf(1);
            assertTrue(exists, "batch 1 recorded");
            assertEq(bkind, 0, "batch 1 kind is Platform");
            assertEq(es.length, 1, "batch 1 has 1 entry");
            assertEq(es[0].paid, req, "batch 1 entry paid exact requested");
            assertEq(lst.balanceOf(h.redeemer()) - redBefore, req, "CashInBatch wallet LST delta");
            assertEq(v.getPosition(id).paidUnderlying - paidBefore, req, "CashInBatch wallet paidUnderlying delta");
        }

        // CashInBatch kind = 2 (Leaderboard -> prize escrow, n = 1, 20% of payableYield).
        {
            uint256 seed = (uint256(2) << 16) | (uint256(2) << 8); // (seed >> 16) % 3 == 2, bound(seed >> 8, 1, 3) == 1
            uint256 n = bound(seed >> 8, 1, 3);
            assertEq(n, 1, "single-entry leaderboard batch");
            uint256 req = (v.payableYield(id) * 20) / 100 + (seed % 5);
            uint256 escBefore = v.escrowShares();
            uint256 escdSharesBefore = v.escrowedShares();
            uint256 escdUnitsBefore = v.escrowedUnits();
            uint256 vaultBalBefore = lst.balanceOf(address(v));

            assertTrue(h.lzCashInBatch(seed, 20, false, false), "CashInBatch escrow delivery must succeed");
            (bool exists, uint8 bkind,, PositionVaultBase.BatchEntry[] memory es) = v.batchOf(2);
            assertTrue(exists, "batch 2 recorded");
            assertEq(bkind, 2, "batch 2 kind is Leaderboard");
            assertEq(es.length, 1, "batch 2 has 1 entry");
            assertEq(es[0].paid, req, "batch 2 entry paid exact requested");
            assertEq(v.escrowShares() - escBefore, req, "CashInBatch escrowShares delta");
            assertEq(v.escrowedShares() - escdSharesBefore, req, "CashInBatch escrowedShares delta");
            assertEq(v.escrowedUnits() - escdUnitsBefore, req, "CashInBatch escrowedUnits delta");
            assertEq(lst.balanceOf(address(v)) - vaultBalBefore, req, "CashInBatch minted LST into vault");
        }
    }

    function _assertPayPrizePositive() internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();
        uint256 escBefore = v.escrowShares();
        uint256 shares = (escBefore * 50) / 100;
        assertGt(shares, 0, "non-zero prize shares");
        uint256 deliv = 0.0005 ether;
        uint256 tenth = (shares * 1_000) / 10_000;
        if (deliv > tenth) deliv = tenth;
        uint256 winnerBefore = lst.balanceOf(h.prizeWinner());
        uint256 feeBefore = lst.balanceOf(h.feeCollector());

        assertTrue(h.lzPayPrize(50, false, 0.0005 ether), "PayPrizeV2 delivery must succeed");
        (uint8 status, uint128 payoutShares,) = v.payouts(1);
        assertEq(status, 1, "PayPrizeV2 status == PRIZE_PAID");
        assertEq(payoutShares, shares, "PayPrizeV2 recorded shares");
        assertEq(escBefore - v.escrowShares(), shares, "PayPrizeV2 escrowShares drop");
        assertEq(lst.balanceOf(h.feeCollector()) - feeBefore, deliv, "PayPrizeV2 delivery fee delta");
        assertEq(lst.balanceOf(h.prizeWinner()) - winnerBefore, shares - deliv, "PayPrizeV2 winner net delta");
    }

    function _assertUnlockPositive(uint64 id) internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();
        uint256 userBefore = lst.balanceOf(h.user());
        uint256 feeBefore = lst.balanceOf(h.feeCollector());
        uint256 vaultBalBefore = lst.balanceOf(address(v));

        assertTrue(h.lzUnlock(0, 1, 0.01 ether), "UnlockV2 delivery must succeed");
        assertEq(v.getPosition(id).inSeq, 4, "UnlockV2 must advance inSeq to 4");
        assertTrue(v.getPosition(id).unlocked, "position marked unlocked");
        assertEq(v.openPrincipalUnderlying(), 0, "openPrincipalUnderlying cleared");
        assertEq(vaultBalBefore - lst.balanceOf(address(v)), 4 ether, "vault released exact 4 ether principal");
        assertEq(lst.balanceOf(h.feeCollector()) - feeBefore, 0.01 ether, "UnlockV2 delivery fee delta");
        assertEq(lst.balanceOf(h.user()) - userBefore, 4 ether - 0.01 ether, "UnlockV2 user net principal delta");
    }

    function _assertNegativeControls(uint64 id) internal {
        PositionVaultOApp v = h.vault();
        SimLST lst = h.lst();
        uint256 userBalFinal = lst.balanceOf(h.user());
        uint256 redBalFinal = lst.balanceOf(h.redeemer());
        uint256 winnerBalFinal = lst.balanceOf(h.prizeWinner());

        h.replayHandledMessage(0, 0);
        h.replayPrizePayout(1);
        h.lzCashInBatch(1, 10, true, true); // tampered batch kind on existing batchId=1
        assertFalse(h.replayMutatedState(), "replays and tampered batches must not mutate state");

        for (uint8 attackKind = 0; attackKind < 7; attackKind++) {
            h.attemptUnauthorizedLzReceive(0, attackKind);
        }
        assertFalse(h.unauthorizedMutated(), "unauthorized lzReceive attacks must not mutate state");

        // Direct revert checks for wrong endpoint, wrong peer, wrong EID.
        uint32 solEid = h.SOLANA_EID();
        bytes32 solPeer = h.SOLANA_PEER();
        bytes32 roguePeer = h.ROGUE_PEER();
        address epAddr = address(h.ep());
        address userAddr = h.user();
        bytes memory freshUnlock = abi.encodePacked(
            uint8(10),
            h.HOODI_EID(),
            bytes32((uint256(uint160(address(v))) << 96) | (uint256(id) << 32)),
            uint64(99),
            uint128(0)
        );
        vm.prank(userAddr);
        vm.expectRevert();
        v.lzReceive(Origin(solEid, solPeer, 1), bytes32(0), freshUnlock, address(0), "");

        vm.prank(epAddr);
        vm.expectRevert();
        v.lzReceive(Origin(solEid, roguePeer, 1), bytes32(0), freshUnlock, address(0), "");

        vm.prank(epAddr);
        vm.expectRevert();
        v.lzReceive(Origin(solEid + 1, solPeer, 1), bytes32(0), freshUnlock, address(0), "");

        assertEq(lst.balanceOf(h.user()), userBalFinal, "negative controls left user balance unchanged");
        assertEq(lst.balanceOf(h.redeemer()), redBalFinal, "negative controls left redeemer balance unchanged");
        assertEq(lst.balanceOf(h.prizeWinner()), winnerBalFinal, "negative controls left prizeWinner balance unchanged");
        assertEq(v.getPosition(id).inSeq, 4, "negative controls left inSeq unchanged");
    }
}
