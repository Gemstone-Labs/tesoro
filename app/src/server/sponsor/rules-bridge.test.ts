import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { CLAIM_RENT, PAYOUT_RECORD_RENT, applyLockedIx, applyYieldIx, payoutPda, refundPrizePayoutIx, routePda, rentTransferIx, sendPayIx, sendPayPrizeIx, sendUnlockIx, type SendQuote } from "@/lib/chain/bridge-bundle";
import { BRIDGE_AUTHORITY, BRIDGE_ID, ETH_VAULTS, bridgePeerPda, bridgeStore, coreAccountPda, corePositionPda, deliveryTermsPda, ethPositionId, redeemToEvmIx, sourceAuthPda, coreUnlockIx, netOfVault, evmLinkPda } from "@/lib/chain/eth";
import { basketPda, spillPda } from "@/lib/chain/basket";
import { TESORO_CORE_ID, sourcePda } from "@/lib/chain/native";
import { key, playerIx } from "./fixtures";
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
  send: [{ pubkey: payer.toBase58(), signer: true, writable: true }, ...Array.from({ length: 25 }, (_, i) => ({ pubkey: key().toBase58(), signer: false, writable: i % 3 === 0 }))],
  feeLamports: fee.toString(),
});
const quote = quoteOf(relayer);

const wire = (ix: { programId: PublicKey; keys: Ix["keys"]; data: Buffer | Uint8Array }): Ix => ({ programId: ix.programId, keys: ix.keys, data: ix.data });
const sendUnlock = (q = quote) => wire(sendUnlockIx({ payer: relayer, vault, pid, quote: q }));
const sendPay = (kind: "yield" | "instant" = "yield", q = quote) => wire(sendPayIx({ kind, payer: relayer, vault, pid, holder: player, holderEvm: evm, sourceIndex: 0, quote: q }));
const redeem = () => wire(redeemToEvmIx(player, position, source, 5n, vault, { line: { side: 0, dueAt: 0n, class: 0, tranche: 0 }, accounts: [key(), key()] }));
const unlock = () => wire(coreUnlockIx(player, position, null));
const applyYield = (books = [key(), key()]) => wire(applyYieldIx({ vault, pid, openAdvance: 0, books }));
const applyLocked = () => wire(applyLockedIx({ payer: relayer, vault, pid, ownerEvm: evm, ownerAccount: holder }));
const transfer = (lamports = CLAIM_RENT) => wire(rentTransferIx(relayer, player, lamports));

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
  it("the Claim's rent from the relayer, for a Player with no SOL, adds its exact amount to the cost", () => {
    const p = plan([transfer(), redeem(), sendPay()]);
    expect(p.names).toEqual(["transfer", "redeem_to_evm", "send_pay_yield"]);
    expect(p.spend.sunk).toBe(285_146n + CLAIM_RENT);
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
    const redeemPrize = (): Ix => {
      const a = (k: PublicKey, signer = false, writable = false) => ({ pubkey: k, isSigner: signer, isWritable: writable });
      return {
        programId: BRIDGE_ID,
        keys: [
          a(player, true, true), a(bridgeStore()), a(BRIDGE_AUTHORITY), a(route, false, true), a(sourceAuthPda(netOfVault(vault))), a(holder), a(evmLinkPda(evm)),
          a(basketPda(holder), false, true), a(spillPda(holder), false, true), a(prizeSource, false, true), a(key(), false, true), a(deliveryTermsPda(vault)), a(TESORO_CORE_ID), a(SystemProgram.programId),
        ],
        data: Buffer.concat([Buffer.from("2f9dfa429d66eb73", "hex"), Buffer.alloc(8)]),
      };
    };
    it("redeem_prize_to_evm then send_pay_prize, with the payout's rent from the relayer", () => {
      const p = plan([transfer(PAYOUT_RECORD_RENT), redeemPrize(), wire(sendPayPrizeIx({ payer: relayer, vault, payoutId: 4n, quote }))]);
      expect(p.names).toEqual(["transfer", "redeem_prize_to_evm", "send_pay_prize"]);
      expect(p.sends![0]).toMatchObject({ kind: "prize", msgType: 13, payoutId: 4n });
      expect(p.sends![0].payout!.equals(payoutPda(netOfVault(vault).eid, Buffer.concat([Buffer.alloc(12), Buffer.from(vault.slice(2), "hex")]), 4n))).toBe(true);
    });
    it("the Claim's rent is not the payout's rent", () => {
      refused([transfer(CLAIM_RENT), redeemPrize()], "bad-transfer");
    });
    it("a rejected payout is refunded by anyone for the holder, with no fee", () => {
      const ix = wire(refundPrizePayoutIx({ vault, payoutId: 4n, holder: player, prizeSource, holderBasket: basketPda(holder), holderSpill: spillPda(holder) }));
      expect(plan([ix])).toMatchObject({ names: ["refund_prize_payout"], sends: [] });
      const stranger = wire(refundPrizePayoutIx({ vault, payoutId: 4n, holder: key(), prizeSource, holderBasket: basketPda(holder), holderSpill: spillPda(holder) }));
      refused([stranger], "bad-account");
    });
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
    a.data = Buffer.from(a.data);
    a.data.writeUInt32LE(4, 8 + 4 + 32);
    refused([a], "bad-data");
    const b = sendUnlock();
    b.data = Buffer.from(b.data);
    b.data.writeBigUInt64LE(1n, b.data.length - 8);
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
    ix.data = Buffer.from(ix.data);
    strange.copy(ix.data, 12);
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
  it("shapes that are not in the list: a send before its redeem, a lone transfer, two sends, a send after a lone apply", () => {
    refused([sendPay(), redeem()], "bad-shape");
    refused([transfer()], "unknown-program");
    refused([sendUnlock(), sendUnlock()], "bad-shape");
    refused([applyLocked(), sendUnlock()], "bad-shape");
    refused([redeem(), sendUnlock()], "bad-shape");
  });
  it("a rent transfer of any other amount, or to anyone but the Player", () => {
    refused([transfer(CLAIM_RENT + 1n), redeem()], "bad-transfer");
    const other = wire(rentTransferIx(relayer, key(), CLAIM_RENT));
    refused([other, redeem()], "bad-account");
    const fromPlayer = wire(rentTransferIx(player, relayer, CLAIM_RENT));
    refused([fromPlayer, redeem()], "bad-account");
  });
  it("a redeem_to_evm that is for another holder's Account", () => {
    const ix = wire(redeemToEvmIx(key(), position, source, 5n, vault, { line: { side: 0, dueAt: 0n, class: 0, tranche: 0 }, accounts: [] }));
    refused([ix], "bad-account");
  });
  it("a redeem_to_evm with the relayer among its extra accounts", () => {
    const ix = redeem();
    ix.keys.push({ pubkey: relayer, isSigner: false, isWritable: true });
    refused([ix], "relayer-in-accounts");
  });
  it("apply_locked with the relayer anywhere but the payer slot", () => {
    const ix = applyLocked();
    ix.keys = ix.keys.map((k, i) => (i === 6 ? { ...k, pubkey: relayer } : k));
    refused([ix], "relayer-in-accounts");
  });
  it("other bridge instructions: init_position, set_route, retire, the admin steps", () => {
    for (const d of ["c5140a0161a0b15b", "0000000000000001"]) refused([{ programId: BRIDGE_ID, keys: [], data: Buffer.from(d, "hex") }], "unknown-instruction");
  });
  it("another core instruction next to a send", async () => {
    refused([await playerIx.redeem(player), sendUnlock()], "bad-shape");
  });
  it("any program besides the bridge, core and a rent transfer", () => {
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
