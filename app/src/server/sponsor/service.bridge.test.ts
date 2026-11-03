import { AddressLookupTableAccount, Keypair, PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { CLAIM_RENT, applyYieldIx, rentTransferIx, sendPayIx, sendUnlockIx, stableBridgeAddresses, type SendQuote } from "@/lib/chain/bridge-bundle";
import { BRIDGE_ID, ETH_VAULTS, coreUnlockIx, deliveryTermsPda, ethPositionId, corePositionPda, redeemToEvmIx } from "@/lib/chain/eth";
import { sourcePda } from "@/lib/chain/native";
import { key } from "./fixtures";
import { DEFAULT_LIMITS, type Limits } from "./policy";
import { CORE_ID, type Ix } from "./rules";
import { Sponsor, accountPda, basketPda, type ChainReads, type SponsorDeps, type WireIx } from "./service";
import { MemoryUsageStore } from "./store";
import type { BridgeSendGuard } from "./bridge-sends";

const SOL = 1_000_000_000n;
const wire = (ixs: Ix[]): { ixs: WireIx[] } => ({
  ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })),
});
const asIx = (ix: { programId: PublicKey; keys: Ix["keys"]; data: Buffer | Uint8Array }): Ix => ({ programId: ix.programId, keys: ix.keys, data: ix.data });

const vault = ETH_VAULTS[0].address;
const pid = ethPositionId(vault, 7n);
const evm = "0x" + "ab".repeat(20);

/** A DeliveryTerms account: the fee settings after the 8 + 4 + 32 + 1 byte header (ticket 14 layout, 105 bytes). */
function termsData(o: { fee: bigint; maxAbs: bigint; bpsUnlock?: number; bpsYield?: number }) {
  const d = Buffer.alloc(105);
  d.writeBigUInt64LE(o.fee, 45);
  d.writeBigUInt64LE(o.maxAbs, 61);
  d.writeUInt16LE(o.bpsUnlock ?? 200, 93);
  d.writeUInt16LE(o.bpsYield ?? 1000, 95);
  return d;
}

/** The bridge's lookup table as the script builds it: the vault's stable addresses and its endpoint accounts. */
const table = (q: SendQuote) => [new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: key(), addresses: stableBridgeAddresses(vault, q) } })];

function setup(over: { limits?: Partial<Limits>; terms?: Buffer | null; guard?: Partial<BridgeSendGuard> | null; tableFor?: (quote: SendQuote) => AddressLookupTableAccount[] } = {}) {
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  const sent: VersionedTransaction[] = [];
  const quote: SendQuote = {
    endpointSettings: key().toBase58(),
    payer: relayer.publicKey.toBase58(),
    send: [{ pubkey: relayer.publicKey.toBase58(), signer: true, writable: true }, ...Array.from({ length: 25 }, (_, i) => ({ pubkey: key().toBase58(), signer: false, writable: i % 3 === 0 }))],
    feeLamports: "285146",
  };
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  const basket = Buffer.alloc(400);
  basket.writeBigUInt64LE(0n, 8 + 40);
  accounts.set(accountPda(player.publicKey).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  accounts.set(basketPda(accountPda(player.publicKey)).toBase58(), { owner: CORE_ID, data: basket });
  if (over.terms !== null) accounts.set(deliveryTermsPda(vault).toBase58(), { owner: BRIDGE_ID, data: over.terms ?? termsData({ fee: 1_000_000_000_000_000n, maxAbs: 3_000_000_000_000_000n }) });
  const chain: ChainReads = {
    getTransaction: async () => null,
    balance: async () => 10n * SOL,
    rent: async (bytes) => BigInt(bytes + 128) * 6960n,
    account: async (k) => accounts.get(k.toBase58()) ?? null,
    accountsTogether: async (keys) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    latestBlockhash: async () => "11111111111111111111111111111111",
    send: async (raw) => {
      sent.push(VersionedTransaction.deserialize(raw));
      return "sig" + sent.length;
    },
  };
  const guard: BridgeSendGuard | undefined = over.guard === null ? undefined : { quote: async () => 285_146n, sendAccounts: async () => quote.send, ...over.guard };
  const deps: SponsorDeps = {
    relayer,
    macKey: Buffer.from("test-mac-key"),
    store: new MemoryUsageStore(),
    limits: { ...DEFAULT_LIMITS, ...over.limits },
    chain,
    isListed: async () => false,
    lookupTables: async () => (over.tableFor ?? table)(quote),
    paused: async () => false,
    alertLowBalance: async () => {},
    lowBalance: 1n * SOL,
    bridgeSends: guard,
    now: () => 1_000_000,
  };
  const position = corePositionPda(pid);
  const source = sourcePda(position, 0);
  const send = asIx(sendUnlockIx({ payer: relayer.publicKey, vault, pid, quote }));
  const unlock = asIx(coreUnlockIx(player.publicKey, position, null));
  return { sponsor: new Sponsor(deps), deps, relayer, player, sent, quote, position, source, send, unlock, accounts };
}

const playerSigns = (b: { message: string }, player: Keypair) => {
  const message = VersionedMessage.deserialize(Buffer.from(b.message, "base64"));
  const tx = new VersionedTransaction(message);
  const i = message.staticAccountKeys.findIndex((k) => k.equals(player.publicKey));
  tx.signatures[i] = nacl.sign.detached(message.serialize(), player.secretKey);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("a sponsored Unlock that carries its LayerZero send", () => {
  it("is built with the relayer as fee payer and LayerZero payer, counts the fee as cost, and goes out", async () => {
    const s = setup();
    const built = await s.sponsor.build(s.player.publicKey, wire([s.unlock, s.send]));
    expect(built.class).toBe("exit");
    expect(BigInt(JSON.parse(built.meta).cost)).toBeGreaterThanOrEqual(285_146n);
    const sig = await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(sig.signature).toBe("sig1");
    expect(s.sent[0].message.staticAccountKeys[0]).toEqual(s.relayer.publicKey);
    expect(s.sent[0].message.compiledInstructions.map((c) => s.sent[0].message.staticAccountKeys[c.programIdIndex].toBase58())).toContain(BRIDGE_ID.toBase58());
  });
  it("is refused as unpaid when the vault's Delivery Terms carry no fee, and the Player may pay it instead", async () => {
    const s = setup({ terms: termsData({ fee: 0n, maxAbs: 5n }) });
    await expect(s.sponsor.build(s.player.publicKey, wire([s.unlock, s.send]))).rejects.toMatchObject({ code: "no-delivery-fee" });
    const t = setup({ terms: null });
    await expect(t.sponsor.build(t.player.publicKey, wire([t.unlock, t.send]))).rejects.toMatchObject({ code: "no-delivery-fee" });
    const u = setup({ terms: termsData({ fee: 1n, maxAbs: 0n }) });
    await expect(u.sponsor.build(u.player.publicKey, wire([u.unlock, u.send]))).rejects.toMatchObject({ code: "no-delivery-fee" });
  });
  it("is refused when the percentage cap that would apply is zero", async () => {
    const s = setup({ terms: termsData({ fee: 1n, maxAbs: 5n, bpsUnlock: 0 }) });
    await expect(s.sponsor.build(s.player.publicKey, wire([s.unlock, s.send]))).rejects.toMatchObject({ code: "no-delivery-fee" });
  });
  it("is limited per Account per day, and a build that fails later gives its count back", async () => {
    const s = setup({ limits: { bridgeSendsPerDay: 2 } });
    await s.sponsor.build(s.player.publicKey, wire([s.unlock, s.send]));
    await s.sponsor.build(s.player.publicKey, wire([s.send]));
    await expect(s.sponsor.build(s.player.publicKey, wire([s.send]))).rejects.toMatchObject({ code: "bridge-send-limit", status: 429 });
    const other = setup({ limits: { bridgeSendsPerDay: 1 } });
    other.accounts.delete(accountPda(other.player.publicKey).toBase58());
    await expect(other.sponsor.build(other.player.publicKey, wire([other.unlock, other.send]))).rejects.toMatchObject({ code: "no-account" });
    // The refused build took nothing: a real Account still has its one send.
    const fresh = setup({ limits: { bridgeSendsPerDay: 1 } });
    await fresh.sponsor.build(fresh.player.publicKey, wire([fresh.send]));
  });
  it("is refused when the fee in the instruction is above a fresh quote", async () => {
    const s = setup({ guard: { quote: async () => 100_000n } });
    await expect(s.sponsor.build(s.player.publicKey, wire([s.send]))).rejects.toMatchObject({ code: "fee-changed" });
    const near = setup({ guard: { quote: async () => 250_000n } });
    await near.sponsor.build(near.player.publicKey, wire([near.send]));
  });
  it("is refused when the endpoint's accounts are not the ones the server computes", async () => {
    const s = setup({ guard: { sendAccounts: async () => [{ pubkey: key().toBase58(), signer: true, writable: true }] } });
    await expect(s.sponsor.build(s.player.publicKey, wire([s.send]))).rejects.toMatchObject({ code: "bad-accounts" });
  });
  it("is refused on a server with no send guard configured", async () => {
    const s = setup({ guard: null });
    await expect(s.sponsor.build(s.player.publicKey, wire([s.send]))).rejects.toMatchObject({ code: "not-configured" });
  });
  it("is for Accounts only", async () => {
    const s = setup();
    s.accounts.delete(accountPda(s.player.publicKey).toBase58());
    await expect(s.sponsor.build(s.player.publicKey, wire([s.send]))).rejects.toMatchObject({ code: "no-account" });
  });
});

describe("a sponsored Redeem for a Player with no SOL", () => {
  it("carries the Claim's rent from the relayer, the Redeem and its send in one message", async () => {
    const s = setup();
    const line = { side: 0, dueAt: 0n, class: 0, tranche: 0 };
    const redeem = asIx(redeemToEvmIx(s.player.publicKey, s.position, s.source, 5n, vault, { line, accounts: [key()] }));
    const pay = asIx(sendPayIx({ kind: "yield", payer: s.relayer.publicKey, vault, pid, holder: s.player.publicKey, holderEvm: evm, sourceIndex: 0, quote: s.quote }));
    const transfer = asIx(rentTransferIx(s.relayer.publicKey, s.player.publicKey, CLAIM_RENT));
    const built = await s.sponsor.build(s.player.publicKey, wire([transfer, redeem, pay]));
    expect(BigInt(JSON.parse(built.meta).cost)).toBeGreaterThanOrEqual(285_146n + CLAIM_RENT);
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
  });
});

describe("message sizes with the bridge lookup table", () => {
  const line = { side: 0, dueAt: 0n, class: 0, tranche: 0 };
  const sizeOf = async (s: ReturnType<typeof setup>, ixs: Ix[]) => {
    const built = await s.sponsor.build(s.player.publicKey, wire(ixs));
    return Buffer.from(built.message, "base64").length + 1 + 64 * (VersionedMessage.deserialize(Buffer.from(built.message, "base64")).header.numRequiredSignatures);
  };
  const books = () => [key(), key(), key(), key()];
  const yieldIx = () => asIx(applyYieldIx({ vault, pid, openAdvance: 0, books: books() }));

  it("Unlock with the open Advance's Source, book and three pages, plus apply_yield and the send", async () => {
    const s = setup();
    const unlock = asIx(coreUnlockIx(s.player.publicKey, s.position, { index: 0, accounts: books() }));
    const size = await sizeOf(s, [yieldIx(), unlock, s.send]);
    console.info("size unlock bundle with apply_yield", size);
    expect(size).toBeLessThanOrEqual(1232);
  });
  it("Redeem with its send, apply_yield and the Claim's rent, for a Player with no SOL", async () => {
    const s = setup();
    const redeem = asIx(redeemToEvmIx(s.player.publicKey, s.position, s.source, 5n, vault, { line, accounts: books() }));
    const pay = asIx(sendPayIx({ kind: "yield", payer: s.relayer.publicKey, vault, pid, holder: s.player.publicKey, holderEvm: evm, sourceIndex: 0, quote: s.quote }));
    const transfer = asIx(rentTransferIx(s.relayer.publicKey, s.player.publicKey, CLAIM_RENT));
    const size = await sizeOf(s, [transfer, yieldIx(), redeem, pay]);
    console.info("size redeem bundle with apply_yield and rent", size);
    expect(size).toBeLessThanOrEqual(1232);
  });
  it("the same Redeem without the table does not fit, which is why the table exists", async () => {
    const s = setup({ tableFor: () => [] });
    const redeem = asIx(redeemToEvmIx(s.player.publicKey, s.position, s.source, 5n, vault, { line, accounts: books() }));
    const pay = asIx(sendPayIx({ kind: "yield", payer: s.relayer.publicKey, vault, pid, holder: s.player.publicKey, holderEvm: evm, sourceIndex: 0, quote: s.quote }));
    await expect(s.sponsor.build(s.player.publicKey, wire([redeem, pay]))).rejects.toMatchObject({ code: "too-large" });
  });
});
