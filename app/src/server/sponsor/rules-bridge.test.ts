import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { CLAIM_RENT, PAYOUT_RECORD_RENT, applyLockedIx, applyYieldIx, payoutPda, refundPrizePayoutIx, routePda, sendPayIx, sendPayPrizeIx, sendUnlockIx, type SendQuote } from "@/lib/chain/bridge-bundle";
import { BRIDGE_AUTHORITY, BRIDGE_ID, ETH_VAULTS, bridgePeerPda, bridgeStore, coreAccountPda, corePositionPda, deliveryTermsPda, ethPositionId, redeemToEvmIx, sourceAuthPda, coreUnlockIx, netOfVault, evmLinkPda } from "@/lib/chain/eth";
import { basketPda, spillPda } from "@/lib/chain/basket";
import { TESORO_CORE_ID, sourcePda } from "@/lib/chain/native";
import { key, playerIx, withPayerAt13 } from "./fixtures";
import { initCkptPageIx } from "@/lib/chain/redeem";
import { MAX_LZ_FEE_LAMPORTS } from "./rules-bridge";
import { planTransaction, type Ix } from "./rules";

const relayer = key();
const player = key();
const ctx = { relayer, player, isGame: () => false };
const plan = (ixs: Ix[]) => planTransaction(ixs, ctx);
const refused = (ixs: Ix[], code: string) => expect(() => plan(ixs)).toThrowError(expect.objectContaining({ code }));

const vault = ETH_VAULTS[0].address;
const other = ETH_VAULTS[1].address;
const pid = ethPositionId(vault, 7n);
const evm = "0x" + "ab".repeat(20);
const holder = coreAccountPda(player);
const position = corePositionPda(pid);
const source = sourcePda(position, 0);

/** The endpoint's send accounts as the server quotes them: the payer first, then 25 more. */
const quoteOf = (payer: PublicKey, fee = 285_146n): SendQuote => ({
  endpointSettings: key().toBase58(),
  payer: payer.toBase58(),
  send: withPayerAt13(payer),
  feeLamports: fee.toString(),
});
const quote = quoteOf(relayer);

const wire = (ix: { programId: PublicKey; keys: Ix["keys"]; data: Buffer | Uint8Array }): Ix => ({ programId: ix.programId, keys: ix.keys, data: ix.data });
const sendUnlock = (q = quote) => wire(sendUnlockIx({ payer: relayer, vault, pid, quote: q }));
const sendPay = (kind: "yield" | "instant" = "yield", q = quote) => wire(sendPayIx({ kind, payer: relayer, vault, pid, holder: player, holderEvm: evm, sourceIndex: 0, quote: q }));
const redeem = (payer: PublicKey = relayer) => wire(redeemToEvmIx(player, position, source, 5n, vault, { line: { side: 0, dueAt: 0n, class: 0, tranche: 0 }, accounts: [key(), key()] }, payer));
const unlock = () => wire(coreUnlockIx(player, position, null));
const applyYield = (books = [key(), key()]) => wire(applyYieldIx({ vault, pid, openAdvance: 0, books }));
const applyLocked = () => wire(applyLockedIx({ payer: relayer, vault, pid, ownerEvm: evm, ownerAccount: holder }));

describe("accepted: the Player's bridge transactions, with the relayer paying LayerZero", () => {
  it("apply_locked alone", () => {
    expect(plan([applyLocked()])).toMatchObject({ names: ["apply_locked"], class: "exit", sends: [], signers: [] });
  });
  it("apply_yield alone, with the open Advance's book and pages", () => {
    expect(plan([applyYield()])).toMatchObject({ names: ["apply_yield"], class: "exit" });
  });
  it("apply_yield on a Position with no open Advance", () => {
    const ix = wire(applyYieldIx({ vault, pid, openAdvance: null, books: [] }));
    expect(plan([ix]).names).toEqual(["apply_yield"]);
  });
  it("unlock then send_unlock: the Player signs, the relayer is the LayerZero payer and the fee is counted as a cost", () => {
    const p = plan([unlock(), sendUnlock()]);
    expect(p).toMatchObject({ names: ["unlock", "send_unlock"], class: "exit", playerSigns: true });
    expect(p.signers.map((s) => s.toBase58())).toEqual([player.toBase58()]);
    expect(p.sends).toHaveLength(1);
    expect(p.sends![0]).toMatchObject({ kind: "unlock", vault, msgType: 10, feeLamports: 285_146n });
    expect(p.spend.sunk).toBe(285_146n);
  });
  it("apply_yield, unlock, send_unlock", () => {
    expect(plan([applyYield(), unlock(), sendUnlock()]).names).toEqual(["apply_yield", "unlock", "send_unlock"]);
  });
  it("redeem_to_evm then send_pay_yield", () => {
    const p = plan([redeem(), sendPay()]);
    expect(p).toMatchObject({ names: ["redeem_to_evm", "send_pay_yield"], class: "exit", playerSigns: true });
    expect(p.sends![0]).toMatchObject({ kind: "yield", msgType: 11 });
  });
  it("apply_yield, redeem_to_evm, send_pay_yield", () => {
    expect(plan([applyYield(), redeem(), sendPay()]).names).toEqual(["apply_yield", "redeem_to_evm", "send_pay_yield"]);
  });
  it("the relayer as the Redeem's payer funds the Claim for a Player with no SOL; the holder only signs, and the rent counts as a cost", () => {
    const p = plan([redeem(), sendPay()]);
    expect(p.spend.sunk).toBe(285_146n + CLAIM_RENT);
    expect(p.signers.map((s) => s.toBase58())).toEqual([player.toBase58()]);
  });
  it("the Player as the payer costs the relayer nothing for the Claim", () => {
    expect(plan([redeem(player), sendPay()]).spend.sunk).toBe(285_146n);
  });
  it("a send alone finishes a transfer that was recorded but not sent", () => {
    expect(plan([sendUnlock()]).names).toEqual(["send_unlock"]);
    expect(plan([sendPay("yield")]).names).toEqual(["send_pay_yield"]);
    expect(plan([sendPay("instant")]).sends![0]).toMatchObject({ kind: "instant", msgType: 12 });
  });
  it("a HyperEVM vault is the same shape", () => {
    const pid2 = ethPositionId(other, 3n);
    const q = quoteOf(relayer, 348_809n);
    expect(plan([wire(sendUnlockIx({ payer: relayer, vault: other, pid: pid2, quote: q }))]).sends![0]).toMatchObject({ vault: other, feeLamports: 348_809n });
    expect(netOfVault(other).key).toBe("hyperevm");
  });
  describe("a Season prize cashed out to the EVM wallet", () => {
    const prizeSource = key();
    const route = routePda(netOfVault(vault).eid, Buffer.concat([Buffer.alloc(12), Buffer.from(vault.slice(2), "hex")]));
    const redeemPrize = (payer: PublicKey = relayer): Ix => {
      const a = (k: PublicKey, signer = false, writable = false) => ({ pubkey: k, isSigner: signer, isWritable: writable });
      return {
        programId: BRIDGE_ID,
        keys: [
          a(player, true, false), a(payer, true, true), a(bridgeStore()), a(BRIDGE_AUTHORITY), a(route, false, true), a(sourceAuthPda(netOfVault(vault))), a(holder), a(evmLinkPda(evm)),
          a(basketPda(holder), false, true), a(spillPda(holder), false, true), a(prizeSource, false, true), a(key(), false, true), a(deliveryTermsPda(vault)), a(TESORO_CORE_ID), a(SystemProgram.programId),
        ],
        data: Buffer.concat([Buffer.from("2f9dfa429d66eb73", "hex"), Buffer.alloc(8)]),
      };
    };
    it("redeem_prize_to_evm then send_pay_prize, the relayer paying the payout's rent (it gets it back at close_payout)", () => {
      const p = plan([redeemPrize(), wire(sendPayPrizeIx({ payer: relayer, vault, payoutId: 4n, quote }))]);
      expect(p.names).toEqual(["redeem_prize_to_evm", "send_pay_prize"]);
      expect(p.spend.refundable).toBe(PAYOUT_RECORD_RENT);
      expect(p.sends![0]).toMatchObject({ kind: "prize", msgType: 13, payoutId: 4n });
      expect(p.sends![0].payout!.equals(payoutPda(netOfVault(vault).eid, Buffer.concat([Buffer.alloc(12), Buffer.from(vault.slice(2), "hex")]), 4n))).toBe(true);
    });
    it("a cash-out with no send is not a shape we pay for", () => {
      refused([redeemPrize()], "bad-shape");
    });
    it("a payer who is neither the relayer nor the Player is refused", () => {
      refused([redeemPrize(key()), wire(sendPayPrizeIx({ payer: relayer, vault, payoutId: 4n, quote }))], "bad-account");
      refused([redeem(key()), sendPay()], "bad-account");
    });
    it("the holder must sign without being the payer's rent source: the holder slot is a read-only signer", () => {
      const ix = redeemPrize();
      ix.keys[0] = { ...ix.keys[0], isWritable: true };
      refused([ix, wire(sendPayPrizeIx({ payer: relayer, vault, payoutId: 4n, quote }))], "bad-flags");
    });
    it("a rejected payout is refunded by anyone for the holder, with no fee", () => {
      const ix = wire(refundPrizePayoutIx({ vault, payoutId: 4n, holder: player, prizeSource, holderBasket: basketPda(holder), holderSpill: spillPda(holder) }));
      expect(plan([ix])).toMatchObject({ names: ["refund_prize_payout"], sends: [] });
      const stranger = wire(refundPrizePayoutIx({ vault, payoutId: 4n, holder: key(), prizeSource, holderBasket: basketPda(holder), holderSpill: spillPda(holder) }));
      refused([stranger], "bad-account");
    });
  });
});

describe("checkpoint pages created by the relayer", () => {
  const page = (n = 0, payer: PublicKey = relayer): Ix => wire(initCkptPageIx(payer, source, 3, n));
  it("come in front of an Unlock, a Redeem or apply_yield, and alone", () => {
    expect(plan([page(), unlock(), sendUnlock()])).toMatchObject({ names: ["unlock", "send_unlock"], pages: [expect.objectContaining({ classId: 3, pageNo: 0 })] });
    expect(plan([page(0), page(1), applyYield(), redeem(), sendPay()]).pages).toHaveLength(2);
    expect(plan([page(), page(1)])).toMatchObject({ names: ["init_ckpt_page", "init_ckpt_page"], pages: expect.any(Array), sends: [] });
  });
  it("are refused with any payer but the relayer, with the relayer elsewhere, twice, or past six", () => {
    refused([page(0, player), unlock(), sendUnlock()], "bad-account");
    const dup = [page(0), page(0), unlock(), sendUnlock()];
    refused(dup, "bad-shape");
    refused(Array.from({ length: 7 }, (_, i) => page(i)), "bad-shape");
    const odd = page();
    odd.keys[1] = { ...odd.keys[1], pubkey: relayer };
    refused([odd], "relayer-in-accounts");
    const flags = page();
    flags.keys[2] = { ...flags.keys[2], isWritable: false };
    refused([flags], "bad-flags");
  });
  it("do not follow the bridge steps", () => {
    refused([unlock(), sendUnlock(), page()], "bad-shape");
  });
});

describe("refused", () => {
  it("a send whose LayerZero fee is above the cap", () => {
    refused([sendUnlock(quoteOf(relayer, MAX_LZ_FEE_LAMPORTS + 1n))], "fee-too-high");
  });
  it("a send with a zero fee", () => {
    refused([sendUnlock(quoteOf(relayer, 0n))], "fee-too-high");
  });
  it("a send with options, or with a LayerZero-token fee", () => {
    const a = sendUnlock();
    const aData = Buffer.from(a.data);
    aData.writeUInt32LE(4, 8 + 4 + 32);
    a.data = aData;
    refused([a], "bad-data");
    const b = sendUnlock();
    const bData = Buffer.from(b.data);
    bData.writeBigUInt64LE(1n, bData.length - 8);
    b.data = bData;
    refused([b], "bad-data");
  });
  it("the relayer anywhere in a send but the payer slots", () => {
    const a = sendUnlock();
    a.keys = a.keys.map((k, i) => (i === 3 ? { ...k, pubkey: relayer } : k));
    refused([a], "bad-account");
    const b = sendUnlock();
    b.keys = b.keys.map((k, i) => (i === 12 ? { ...k, pubkey: relayer } : k));
    refused([b], "relayer-in-accounts");
  });
  it("the relayer twice among the endpoint's accounts", () => {
    const a = sendUnlock();
    a.keys = a.keys.map((k, i) => (i === 12 ? { ...k, pubkey: relayer, isSigner: true, isWritable: true } : k));
    refused([a], "relayer-in-accounts");
  });
  it("a second signer among the endpoint's accounts", () => {
    const a = sendUnlock();
    a.keys = a.keys.map((k, i) => (i === 12 ? { ...k, isSigner: true } : k));
    refused([a], "bad-accounts");
  });
  it("a send with the wrong number of endpoint accounts", () => {
    const a = sendUnlock();
    a.keys = a.keys.slice(0, 12);
    refused([a], "bad-accounts");
  });
  it("a Position on a contract the app does not list", () => {
    const strange = ethPositionId("0x" + "cd".repeat(20), 1n);
    const ix = sendUnlock();
    const data = Buffer.from(ix.data);
    strange.copy(data, 12);
    ix.data = data;
    refused([ix], "bad-vault");
  });
  it("send_pay_yield for another Account's Claim", () => {
    const ix = sendPayIx({ kind: "yield", payer: relayer, vault, pid, holder: key(), holderEvm: evm, sourceIndex: 0, quote });
    refused([wire(ix)], "bad-account");
  });
  it("a Redeem whose send is for a different Claim", () => {
    const ix = wire(sendPayIx({ kind: "yield", payer: relayer, vault, pid, holder: player, holderEvm: evm, sourceIndex: 1, quote }));
    refused([redeem(), ix], "bad-shape");
  });
  it("a Redeem and a send on different Locks", () => {
    const pid2 = ethPositionId(vault, 8n);
    const ix = wire(sendPayIx({ kind: "yield", payer: relayer, vault, pid: pid2, holder: player, holderEvm: evm, sourceIndex: 0, quote }));
    refused([redeem(), ix], "bad-shape");
  });
  it("an Unlock and a send for another Position", () => {
    const pid2 = ethPositionId(vault, 8n);
    refused([unlock(), wire(sendUnlockIx({ payer: relayer, vault, pid: pid2, quote }))], "bad-shape");
  });
  it("shapes that are not in the list: a send before its redeem, a Redeem or cash-out with no send, two sends, a send after a lone apply", () => {
    refused([sendPay(), redeem()], "bad-shape");
    refused([redeem()], "bad-shape");
    refused([sendUnlock(), sendUnlock()], "bad-shape");
    refused([applyLocked(), sendUnlock()], "bad-shape");
    refused([redeem(), sendUnlock()], "bad-shape");
  });
  it("a redeem_to_evm that is for another holder's Account", () => {
    const ix = wire(redeemToEvmIx(key(), position, source, 5n, vault, { line: { side: 0, dueAt: 0n, class: 0, tranche: 0 }, accounts: [] }, relayer));
    refused([ix, sendPay()], "bad-account");
  });
  it("a redeem_to_evm with the relayer among its extra accounts", () => {
    const ix = redeem();
    ix.keys.push({ pubkey: relayer, isSigner: false, isWritable: true });
    refused([ix, sendPay()], "relayer-in-accounts");
  });
  it("apply_locked with the relayer anywhere but the payer slot", () => {
    const ix = applyLocked();
    ix.keys = ix.keys.map((k, i) => (i === 6 ? { ...k, pubkey: relayer } : k));
    refused([ix], "relayer-in-accounts");
  });
  it("other bridge instructions: init_position, set_route, retire, the admin steps", () => {
    for (const d of ["c5140a0161a0b15b", "0000000000000001"]) refused([{ programId: BRIDGE_ID, keys: [], data: Buffer.from(d, "hex") }], "bad-shape");
  });
  it("another core instruction next to a send", async () => {
    refused([await playerIx.redeem(player), sendUnlock()], "bad-shape");
  });
  it("any program besides the bridge and core", () => {
    refused([applyLocked(), { programId: key(), keys: [], data: Buffer.alloc(8) }], "unknown-program");
  });
  it("the relayer's key as an extra account of apply_yield", () => {
    const ix = applyYield([relayer]);
    refused([ix], "relayer-in-accounts");
  });
  it("a PDA that is not the one of the Position", () => {
    const ix = applyLocked();
    ix.keys = ix.keys.map((k, i) => (i === 3 ? { ...k, pubkey: key() } : k));
    refused([ix], "bad-account");
    const peer = bridgePeerPda(other);
    const ix2 = sendUnlock();
    ix2.keys = ix2.keys.map((k, i) => (i === 1 ? { ...k, pubkey: peer } : k));
    refused([ix2], "bad-account");
  });
});
