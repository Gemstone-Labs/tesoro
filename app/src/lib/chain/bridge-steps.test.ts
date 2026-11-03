import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CLAIM_RENT, bundleNameOf, type SendQuote } from "./bridge-bundle";
import { ETH_VAULTS, coreAccountPda, corePositionPda, ethPositionId } from "./eth";
import { sourcePda } from "./native";
import { linkedAccount, openingGroups, redeemGroups, sendGroups, unlockGroups, yieldDue, type ApplyYieldPlan } from "./bridge-steps";
import { planTransaction, type Ix } from "@/server/sponsor/rules";
import { initCkptPageIx } from "./redeem";

const relayer = Keypair.generate().publicKey;
const player = Keypair.generate().publicKey;
const vault = ETH_VAULTS[0].address;
const id = 7n;
const position = corePositionPda(ethPositionId(vault, id));
const source = sourcePda(position, 0);
const evm = "0x" + "ab".repeat(20);
const books = [Keypair.generate().publicKey, Keypair.generate().publicKey];
const k = () => ({ pubkey: Keypair.generate().publicKey.toBase58(), signer: false, writable: false });
const quote = (payer: PublicKey): SendQuote => ({
  endpointSettings: Keypair.generate().publicKey.toBase58(),
  payer: payer.toBase58(),
  send: [...Array.from({ length: 13 }, () => k()), { pubkey: payer.toBase58(), signer: true, writable: true }, ...Array.from({ length: 12 }, () => k())],
  feeLamports: "285146",
});
const yieldPlan: ApplyYieldPlan = { openAdvance: 0, books, create: [] };
const line = { side: 0, dueAt: 0n, class: 0, tranche: 0 };
const accepted = (ixs: unknown[]) => planTransaction(ixs as Ix[], { relayer, player, isGame: () => false });
const names = (ixs: { programId: PublicKey; data: Uint8Array }[]) => ixs.map((i) => bundleNameOf(i.data) ?? "core");

describe("Unlock", () => {
  const base = { player, vault, id, position, open: { index: 0, accounts: books, create: [] }, applyYield: null };
  it("sponsored: one group, the Unlock then its send, the relayer paying LayerZero, and the sponsor accepts it", () => {
    const groups = unlockGroups({ ...base, payer: relayer, sponsored: true, quote: quote(relayer) });
    expect(groups).toHaveLength(1);
    expect(names(groups[0])).toEqual(["core", "send_unlock"]);
    expect(accepted(groups[0])).toMatchObject({ names: ["unlock", "send_unlock"] });
  });
  it("sponsored with a Yield Report waiting: apply_yield goes first", () => {
    const [group] = unlockGroups({ ...base, applyYield: yieldPlan, payer: relayer, sponsored: true, quote: quote(relayer) });
    expect(names(group)).toEqual(["apply_yield", "core", "send_unlock"]);
    expect(accepted(group).names).toEqual(["apply_yield", "unlock", "send_unlock"]);
  });
  it("self-paid: the Unlock and the send travel apart, each paid by the Player", () => {
    const groups = unlockGroups({ ...base, applyYield: yieldPlan, payer: player, sponsored: false, quote: quote(player) });
    expect(groups.map(names)).toEqual([["apply_yield", "core"], ["send_unlock"]]);
    expect(groups[1][0].keys[0].pubkey.equals(player)).toBe(true);
  });
  it("a checkpoint page to create goes in front, paid by the relayer, and the sponsor accepts it", () => {
    const create = [initCkptPageIx(relayer, source, 3, 1)];
    const [group] = unlockGroups({ ...base, open: { index: 0, accounts: books, create }, payer: relayer, sponsored: true, quote: quote(relayer) });
    expect(accepted(group)).toMatchObject({ names: ["unlock", "send_unlock"], pages: [expect.objectContaining({ pageNo: 1 })] });
    const own = unlockGroups({ ...base, open: { index: 0, accounts: books, create: [initCkptPageIx(player, source, 3, 1)] }, payer: player, sponsored: false, quote: quote(player) });
    expect(own[0]).toHaveLength(2);
  });
});

describe("Redeem", () => {
  const base = { player, vault, id, position, source, sourceIndex: 0, gemas: 5n, target: { line, accounts: books }, create: [], holderEvm: evm, applyYield: null };
  it("sponsored: the Redeem then its send, the relayer paying the Claim's rent and the holder only signing; the sponsor accepts it", () => {
    const [group] = redeemGroups({ ...base, payer: relayer, sponsored: true, quote: quote(relayer) });
    expect(names(group)).toEqual(["redeem_to_evm", "send_pay_yield"]);
    const [holder, payer] = group[0].keys;
    expect(holder).toMatchObject({ isSigner: true, isWritable: false });
    expect(holder.pubkey.equals(player)).toBe(true);
    expect(payer).toMatchObject({ isSigner: true, isWritable: true });
    expect(payer.pubkey.equals(relayer)).toBe(true);
    const plan = accepted(group);
    expect(plan.names).toEqual(["redeem_to_evm", "send_pay_yield"]);
    expect(plan.spend.sunk).toBe(285_146n + CLAIM_RENT);
  });
  it("with a Yield Report waiting: apply_yield goes first", () => {
    const [group] = redeemGroups({ ...base, applyYield: yieldPlan, payer: relayer, sponsored: true, quote: quote(relayer) });
    expect(accepted(group).names).toEqual(["apply_yield", "redeem_to_evm", "send_pay_yield"]);
  });
  it("self-paid: the Redeem with the Player as payer, then the send alone", () => {
    const groups = redeemGroups({ ...base, payer: player, sponsored: false, quote: quote(player) });
    expect(groups.map(names)).toEqual([["redeem_to_evm"], ["send_pay_yield"]]);
    expect(groups[0][0].keys[1].pubkey.equals(player)).toBe(true);
  });
});

describe("finishing a transfer", () => {
  it("the send alone is accepted: Unlock, Redeem and Instant Redeem", () => {
    expect(accepted(sendGroups({ payer: relayer, vault, id, kind: "unlock", quote: quote(relayer) })[0]).names).toEqual(["send_unlock"]);
    expect(accepted(sendGroups({ payer: relayer, vault, id, kind: "yield", player, holderEvm: evm, sourceIndex: 0, quote: quote(relayer) })[0]).names).toEqual(["send_pay_yield"]);
    expect(accepted(sendGroups({ payer: relayer, vault, id, kind: "instant", player, holderEvm: evm, sourceIndex: 0, quote: quote(relayer) })[0]).names).toEqual(["send_pay_instant"]);
  });
  it("apply_locked alone is accepted and names the Account the EVM address is linked to", () => {
    const [[ix]] = openingGroups({ payer: relayer, vault, id, ownerEvm: evm, ownerAccount: coreAccountPda(player) });
    expect(accepted([ix]).names).toEqual(["apply_locked"]);
  });
  it("reads the linked Account from an EvmLink, null when absent", async () => {
    const data = Buffer.alloc(8 + 20 + 32 + 32 + 1);
    coreAccountPda(player).toBuffer().copy(data, 28);
    expect((await linkedAccount({ getAccountInfo: async () => ({ data }) }, evm))?.equals(coreAccountPda(player))).toBe(true);
    expect(await linkedAccount({ getAccountInfo: async () => null }, evm)).toBeNull();
  });
  it("a Yield Report is due when the vault's latest is newer than the applied one", () => {
    const b = (last: bigint, applied: bigint) => ({ bridge: { lastYieldSeq: last, appliedYieldSeq: applied } }) as never;
    expect(yieldDue(b(3n, 2n))).toBe(true);
    expect(yieldDue(b(2n, 2n))).toBe(false);
    expect(yieldDue(b(0n, 0n))).toBe(false);
    expect(yieldDue(null)).toBe(false);
  });
});
