import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { chunkIx, coreIx, key, openMatchIx } from "./fixtures";
import { DEFAULT_LIMITS, type Limits } from "./policy";
import { CORE_ID, type Ix } from "./rules";
import { Sponsor, accountPda, basketPda, type ChainReads, type SponsorDeps, type WireIx } from "./service";
import { MemoryUsageStore } from "./store";

const SOL = 1_000_000_000n;
const wire = (ixs: Ix[]): { ixs: WireIx[] } => ({
  ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })),
});
const basketData = (gemas: bigint) => {
  const d = Buffer.alloc(400);
  d.writeBigUInt64LE(gemas, 8 + 40);
  return d;
};

function setup(over: { balance?: bigint; limits?: Partial<Limits>; paused?: boolean; gemas?: bigint; existing?: PublicKey[]; sendFails?: boolean; noAccount?: boolean } = {}) {
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  const game = key();
  const sent: VersionedTransaction[] = [];
  const alerts: bigint[] = [];
  let balance = over.balance ?? 10n * SOL;
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  accounts.set(basketPda(accountPda(player.publicKey)).toBase58(), { owner: CORE_ID, data: basketData(over.gemas ?? 500n) });
  if (!over.noAccount) accounts.set(accountPda(player.publicKey).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  for (const k of over.existing ?? []) accounts.set(k.toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  const chain: ChainReads = {
    balance: async () => balance,
    account: async (k) => accounts.get(k.toBase58()) ?? null,
    latestBlockhash: async () => "11111111111111111111111111111111",
    send: async (raw) => {
      if (over.sendFails) throw new Error("custom program error 0x1");
      const tx = VersionedTransaction.deserialize(raw);
      sent.push(tx);
      return "sig" + sent.length;
    },
  };
  let t = 1_000_000;
  const deps: SponsorDeps = {
    relayer,
    macKey: Buffer.from("test-mac-key"),
    store: new MemoryUsageStore(),
    limits: { ...DEFAULT_LIMITS, ...over.limits },
    chain,
    isListed: async (p) => p.equals(game),
    lookupTables: async () => [],
    paused: async () => !!over.paused,
    alertLowBalance: async (b) => void alerts.push(b),
    lowBalance: 1n * SOL,
    now: () => t,
  };
  return { sponsor: new Sponsor(deps), deps, relayer, player, game, sent, alerts, setBalance: (b: bigint) => (balance = b), tick: (ms: number) => (t += ms) };
}

/** The wallet's part: deserialise the message we built, sign it. */
function playerSigns(built: { message: string }, player: Keypair): string {
  const message = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
  const tx = new VersionedTransaction(message);
  // A pure exit has the relayer as its only signer: nothing for the Player to sign.
  if (message.staticAccountKeys.slice(1, message.header.numRequiredSignatures).some((k) => k.equals(player.publicKey))) tx.sign([player]);
  return Buffer.from(tx.serialize()).toString("base64");
}

describe("an admission", () => {
  it("is built by the server, signed by the Player, then by the relayer, and sent", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const built = await s.sponsor.build(s.player.publicKey, wire([open]));
    expect(built.class).toBe("admission");
    const { signature } = await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(signature).toBe("sig1");
    const tx = s.sent[0];
    const bytes = tx.message.serialize();
    expect(tx.message.staticAccountKeys[0].equals(s.relayer.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(bytes, tx.signatures[0], s.relayer.publicKey.toBytes())).toBe(true);
    expect(nacl.sign.detached.verify(bytes, tx.signatures[1], s.player.publicKey.toBytes())).toBe(true);
  });
  it("is refused for an Account without Gemas", async () => {
    const s = setup({ gemas: 0n });
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "no-gemas" });
  });
  it("is refused when the Player did not sign for themselves", async () => {
    const s = setup();
    const other = Keypair.generate();
    const open = await openMatchIx(s.relayer.publicKey, other.publicKey, s.game);
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "bad-signer" });
  });
  it("holds a completion reserve that close_match frees", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const matchState = open.keys[13].pubkey;
    const b1 = await s.sponsor.build(s.player.publicKey, wire([open]));
    await s.sponsor.submit(playerSigns(b1, s.player), b1.meta, b1.mac);
    expect(await s.deps.store.held()).toBe(DEFAULT_LIMITS.completionReserve);
    const s2 = setup({ existing: [matchState] });
    await s2.deps.store.hold(matchState.toBase58(), 300_000n);
    const r = s2.relayer.publicKey;
    const close = await coreIx("close_match", [], { caller: r, matchState, matchPayer: r, potA: key(), potAPayer: r, potB: null, potBPayer: null, sponsor: null });
    const built = await s2.sponsor.build(s2.player.publicKey, wire([close]));
    await s2.sponsor.submit(playerSigns(built, s2.player), built.meta, built.mac);
    expect(await s2.deps.store.held()).toBe(0n);
  });
});

describe("pause and the exit reserve", () => {
  it("paused: admissions stop, exits and the Player's own SOL still work", async () => {
    const s = setup({ paused: true, existing: [] });
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "sponsor-paused", status: 503 });
    const matchState = key();
    const s2 = setup({ paused: true, existing: [matchState] });
    const built = await s2.sponsor.build(s2.player.publicKey, wire([await chunkIx(s2.relayer.publicKey, matchState, 3)]));
    expect(built.class).toBe("exit");
    await s2.sponsor.submit(playerSigns(built, s2.player), built.meta, built.mac);
    expect(s2.sent).toHaveLength(1);
  });
  it("a balance that only covers the floor and the holds refuses admissions but not exits", async () => {
    const matchState = key();
    const s = setup({ balance: DEFAULT_LIMITS.floor + 1_000n, existing: [matchState] });
    await s.deps.store.hold("other", 900n);
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "sponsor-paused" });
    const built = await s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, matchState)]));
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
  });
  it("an exit for something that does not exist is refused", async () => {
    const s = setup();
    await expect(s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, key())]))).rejects.toMatchObject({ code: "no-obligation" });
  });
  it("an empty relayer cannot pay even an exit, and says to self-pay", async () => {
    const matchState = key();
    const s = setup({ balance: 1_000n, existing: [matchState] });
    await expect(s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, matchState)]))).rejects.toMatchObject({ code: "sponsor-empty" });
  });
});

describe("limits through the service", () => {
  it("failures are counted and then stop admissions", async () => {
    const s = setup({ sendFails: true, limits: { failuresPerDay: 1 } });
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const built = await s.sponsor.build(s.player.publicKey, wire([open]));
    await expect(s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac)).rejects.toMatchObject({ code: "chain" });
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "too-many-failures" });
  });
  it("a day's admissions per Account", async () => {
    const s = setup({ limits: { accountPerDay: 1 } });
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await s.sponsor.build(s.player.publicKey, wire([open]));
    await expect(s.sponsor.build(s.player.publicKey, wire([open]))).rejects.toMatchObject({ code: "account-limit", status: 429 });
  });
});

describe("what we sign", () => {
  it("only the bytes we built: a changed message, a swapped meta or a missing Player signature is refused", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const built = await s.sponsor.build(s.player.publicKey, wire([open]));
    const signed = playerSigns(built, s.player);
    await expect(s.sponsor.submit(signed, built.meta.replace(s.player.publicKey.toBase58(), key().toBase58()), built.mac)).rejects.toMatchObject({ code: "not-ours" });
    const other = await s.sponsor.build(s.player.publicKey, wire([await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game)]));
    await expect(s.sponsor.submit(playerSigns(other, s.player), built.meta, built.mac)).rejects.toMatchObject({ code: "not-ours" });
    const unsigned = Buffer.from(new VersionedTransaction(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).message).serialize()).toString("base64");
    await expect(s.sponsor.submit(unsigned, built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
    expect(s.sent).toHaveLength(0);
  });
  it("not after the message expired", async () => {
    const s = setup();
    const built = await s.sponsor.build(s.player.publicKey, wire([await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game)]));
    s.tick(80_000);
    await expect(s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac)).rejects.toMatchObject({ code: "expired" });
  });
  it("a transaction with an instruction we do not pay for never gets a message", async () => {
    const s = setup();
    const { SystemProgram } = await import("@solana/web3.js");
    const transfer = SystemProgram.transfer({ fromPubkey: s.relayer.publicKey, toPubkey: s.player.publicKey, lamports: 1 });
    await expect(s.sponsor.build(s.player.publicKey, wire([transfer]))).rejects.toMatchObject({ code: "unknown-program" });
  });
});

describe("a listed Game", () => {
  it("is sponsored with the Player as the only signer; an unlisted one is not", async () => {
    const s = setup();
    const ix = (program: PublicKey): Ix => ({ programId: program, keys: [{ pubkey: s.player.publicKey, isSigner: true, isWritable: true }], data: new Uint8Array([9]) });
    const built = await s.sponsor.build(s.player.publicKey, wire([ix(s.game)]));
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    await expect(s.sponsor.build(s.player.publicKey, wire([ix(key())]))).rejects.toMatchObject({ code: "unknown-program" });
  });
});

describe("the low-balance email", () => {
  it("goes out once for a stretch of low balance", async () => {
    const s = setup({ balance: 500_000_000n });
    const matchState = key();
    s.deps.chain.account = async () => ({ owner: CORE_ID, data: new Uint8Array(10) });
    for (let i = 0; i < 3; i++) await s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, matchState)]));
    expect(s.alerts).toEqual([500_000_000n]);
    s.tick(5 * 3_600_000);
    await s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, matchState)]));
    expect(s.alerts).toHaveLength(2);
  });
});

describe("reserve timing and exits for throwaway keys", () => {
  it("an admission that is built but never submitted holds nothing", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await s.sponsor.build(s.player.publicKey, wire([open]));
    expect(await s.deps.store.held()).toBe(0n);
  });
  it("holds the reserve when submitted, and gives it back when the send fails", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const built = await s.sponsor.build(s.player.publicKey, wire([open]));
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(await s.deps.store.held()).toBe(DEFAULT_LIMITS.completionReserve);
    const f = setup({ sendFails: true });
    const open2 = await openMatchIx(f.relayer.publicKey, f.player.publicKey, f.game);
    const b2 = await f.sponsor.build(f.player.publicKey, wire([open2]));
    await expect(f.sponsor.submit(playerSigns(b2, f.player), b2.meta, b2.mac)).rejects.toMatchObject({ code: "chain" });
    expect(await f.deps.store.held()).toBe(0n);
  });
  it("an exit or a Game move from a key with no Account is refused", async () => {
    const ms = key();
    const s = setup({ noAccount: true, existing: [ms] });
    await expect(s.sponsor.build(s.player.publicKey, wire([await chunkIx(s.relayer.publicKey, ms)]))).rejects.toMatchObject({ code: "no-account" });
  });
});
