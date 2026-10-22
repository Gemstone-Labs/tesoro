import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { accountOf, backingPairIx, chunkIx, coreIx, createAccountIx, key, linkEvmBridgeIx, signUpIx, openMatchIx, playerIx } from "./fixtures";
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

function setup(over: { balance?: bigint; limits?: Partial<Limits>; paused?: boolean; gemas?: bigint; existing?: PublicKey[]; sendFails?: boolean; noAccount?: boolean; invite?: { redeemed: boolean } } = {}) {
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  const game = key();
  const sent: VersionedTransaction[] = [];
  const alerts: bigint[] = [];
  const onboardingAlerts: number[] = [];
  const inviteKey = Keypair.generate();
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
    invite: over.invite ? { key: inviteKey, redeemed: async () => over.invite!.redeemed } : undefined,
    alertOnboarding: async (used) => void onboardingAlerts.push(used),
    now: () => t,
  };
  return { accounts, sponsor: new Sponsor(deps), deps, relayer, player, game, sent, alerts, onboardingAlerts, inviteKey, setBalance: (b: bigint) => (balance = b), tick: (ms: number) => (t += ms) };
}

/** Every wallet in `players` that must sign the message we built does so, in any order. */
function signedBy(built: { message: string }, players: Keypair[]): string {
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(built.message, "base64")));
  tx.sign(players);
  return Buffer.from(tx.serialize()).toString("base64");
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

describe("the Player's own exits (ticket 18b)", () => {
  const shapes: [string, (a: PublicKey) => Promise<Ix>][] = [
    ["redeem", playerIx.redeem],
    ["redeem_prize", playerIx.redeemPrize],
    ["unlock", playerIx.unlock],
    ["return_own", playerIx.returnOwn],
    ["claim_free_yield", playerIx.claimFreeYield],
    ["cancel_offer", (a) => playerIx.cancelOffer(a)],
    ["cancel_request", (a) => playerIx.cancelRequest(a)],
    ["cancel_instant_redeem", (a) => playerIx.cancelInstantRedeem(a)],
    ["expire_instant_redeem", (a) => playerIx.expireInstantRedeem(a)],
  ];
  for (const [name, make] of shapes) {
    it(`${name}: sponsored while paused, with the day's quota spent, below the floor and after build spam`, async () => {
      const s = setup({ paused: true, balance: DEFAULT_LIMITS.floor / 2n, limits: { accountPerDay: 0, globalPerDay: 0, failuresPerDay: 0, cyclesPerDay: 0, buildsPerDay: 2 } });
      for (let i = 0; i < 2; i++) await expect(s.sponsor.build(s.player.publicKey, wire([await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game)]))).rejects.toBeTruthy();
      const built = await s.sponsor.build(s.player.publicKey, wire([await make(s.player.publicKey)]));
      expect(built.class).toBe("exit");
      await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].message.staticAccountKeys[0].equals(s.relayer.publicKey)).toBe(true);
    });
  }
  it("is refused for a key with no Account, and for an instruction signed by someone else", async () => {
    const s = setup({ noAccount: true });
    await expect(s.sponsor.build(s.player.publicKey, wire([await playerIx.unlock(s.player.publicKey)]))).rejects.toMatchObject({ code: "no-account" });
    const t = setup();
    await expect(t.sponsor.build(t.player.publicKey, wire([await playerIx.unlock(key())]))).rejects.toMatchObject({ code: "bad-signer" });
  });
  it("when the relayer is empty the Player is told to pay the fee", async () => {
    const s = setup({ balance: 1_000n });
    await expect(s.sponsor.build(s.player.publicKey, wire([await playerIx.unlock(s.player.publicKey)]))).rejects.toMatchObject({ code: "sponsor-empty" });
  });
  it("an unsigned exit is not sent", async () => {
    const s = setup();
    const built = await s.sponsor.build(s.player.publicKey, wire([await playerIx.redeem(s.player.publicKey)]));
    const bare = Buffer.from(new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(built.message, "base64"))).serialize()).toString("base64");
    await expect(s.sponsor.submit(bare, built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
  });
  it("request_instant_redeem: the relayer pays the order's rent for a Player with no SOL, and it stops while paused", async () => {
    const s = setup();
    const built = await s.sponsor.build(s.player.publicKey, wire([await playerIx.requestInstantRedeem(s.player.publicKey, s.relayer.publicKey, true)]));
    expect(built.class).toBe("admission");
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
    const p = setup({ paused: true });
    await expect(p.sponsor.build(p.player.publicKey, wire([await playerIx.requestInstantRedeem(p.player.publicKey, p.relayer.publicKey, true)]))).rejects.toMatchObject({ code: "sponsor-paused" });
  });
  it("cancelling a sponsored order is an exit that works while paused", async () => {
    const s = setup({ paused: true });
    const built = await s.sponsor.build(s.player.publicKey, wire([await playerIx.cancelInstantRedeem(s.player.publicKey, key(), s.relayer.publicKey, true)]));
    expect(built.class).toBe("exit");
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
  });
  it("exits that keep failing stop being sponsored for that Account, other Accounts are unaffected", async () => {
    const s = setup({ sendFails: true, limits: { exitFailuresPerDay: 3 } });
    for (let i = 0; i < 3; i++) {
      const built = await s.sponsor.build(s.player.publicKey, wire([await playerIx.unlock(s.player.publicKey)]));
      await expect(s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac)).rejects.toMatchObject({ code: "chain" });
    }
    await expect(s.sponsor.build(s.player.publicKey, wire([await playerIx.unlock(s.player.publicKey)]))).rejects.toMatchObject({ code: "too-many-failures" });
    s.tick(25 * 60 * 60 * 1000);
    await expect(s.sponsor.build(s.player.publicKey, wire([await playerIx.unlock(s.player.publicKey)]))).resolves.toBeTruthy();
  });
});

describe("a Backing Ticket signed by the Requester alone (ticket 18b)", () => {
  async function pair(over: Parameters<typeof setup>[0] = {}, backerGemas = 500n) {
    const s = setup(over);
    const backer = Keypair.generate();
    const made = await backingPairIx(s.relayer.publicKey, { requester: s.player.publicKey, backer: backer.publicKey });
    s.accounts.set(accountOf(backer.publicKey).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
    s.accounts.set(basketPda(accountOf(backer.publicKey)).toBase58(), { owner: CORE_ID, data: basketData(backerGemas) });
    return { s, backer, ixs: made.ixs };
  }
  it("is built once, signed by the Requester, then sent with the relayer paying; the Backer is not asked", async () => {
    const { s, ixs } = await pair({ gemas: 0n });
    const built = await s.sponsor.build(s.player.publicKey, wire(ixs));
    expect(built.class).toBe("admission");
    const { signature } = await s.sponsor.submit(signedBy(built, [s.player]), built.meta, built.mac);
    expect(signature).toBe("sig1");
    expect(s.sent[0].message.staticAccountKeys[0].equals(s.relayer.publicKey)).toBe(true);
    expect(s.sent[0].message.header.numRequiredSignatures).toBe(2);
    expect(await s.deps.store.held()).toBe(DEFAULT_LIMITS.completionReserve);
  });
  it("the Backer's Gemas fund it: a Backer with none is refused, a Requester with none is fine", async () => {
    const { s, ixs } = await pair({ gemas: 500n }, 0n);
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "no-gemas" });
  });
  it("a Requester with no Account is refused", async () => {
    const { s, ixs } = await pair({ gemas: 0n, noAccount: true });
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "no-account" });
  });
  it("is refused when it is not signed, or signed by someone else, and expires", async () => {
    const { s, backer, ixs } = await pair({ gemas: 0n });
    const built = await s.sponsor.build(s.player.publicKey, wire(ixs));
    await expect(s.sponsor.submit(signedBy(built, []), built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
    const tx = VersionedTransaction.deserialize(Buffer.from(signedBy(built, [s.player]), "base64"));
    tx.signatures[1] = nacl.sign.detached(tx.message.serialize(), backer.secretKey);
    await expect(s.sponsor.submit(Buffer.from(tx.serialize()).toString("base64"), built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
    tx.signatures[1] = nacl.sign.detached(Buffer.from("something else"), s.player.secretKey);
    await expect(s.sponsor.submit(Buffer.from(tx.serialize()).toString("base64"), built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
    expect(s.sent).toHaveLength(0);
    s.tick(80_000);
    await expect(s.sponsor.submit(signedBy(built, [s.player]), built.meta, built.mac)).rejects.toMatchObject({ code: "expired" });
  });
  it("is paused with the other admissions", async () => {
    const { s, ixs } = await pair({ paused: true, gemas: 0n });
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "sponsor-paused" });
  });
  it("whoever asks must be the signer", async () => {
    const { ixs } = await pair({ gemas: 0n });
    const t = setup();
    await expect(t.sponsor.build(t.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "bad-signer" });
  });
});

describe("a new Account on the sponsor (ticket 18c)", () => {
  const create = (s: ReturnType<typeof setup>, over?: { invite?: PublicKey }) => createAccountIx(s.relayer.publicKey, s.player.publicKey, over);
  it("needs no Gemas and no SOL: built, signed by the new wallet alone, sent", async () => {
    const s = setup({ noAccount: true, gemas: 0n });
    const built = await s.sponsor.build(s.player.publicKey, wire([await create(s)]), "privy-user-1");
    expect(built.class).toBe("admission");
    expect((await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac)).signature).toBe("sig1");
    expect(await s.deps.store.used("onboard-user:privy-user-1", 100 * 365 * 86_400_000, 1_000_000)).toBe(1);
  });
  it("is for wallets without an Account", async () => {
    const s = setup({ gemas: 0n });
    await expect(s.sponsor.build(s.player.publicKey, wire([await create(s)]), "u")).rejects.toMatchObject({ code: "has-account" });
  });
  it("gives one Account per user, even to another wallet of the same user", async () => {
    const s = setup({ noAccount: true });
    const b = await s.sponsor.build(s.player.publicKey, wire([await create(s)]), "same-user");
    await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac);
    const other = setup({ noAccount: true });
    const second = new Sponsor({ ...other.deps, store: s.deps.store });
    await expect(second.build(other.player.publicKey, wire([await createAccountIx(other.relayer.publicKey, other.player.publicKey)]), "same-user")).rejects.toMatchObject({ code: "account-limit" });
    await expect(second.build(other.player.publicKey, wire([await createAccountIx(other.relayer.publicKey, other.player.publicKey)]), "another-user")).resolves.toBeTruthy();
  });
  it("a build that is never sent, or a send that fails, does not use up the user's Account", async () => {
    const s = setup({ noAccount: true });
    await s.sponsor.build(s.player.publicKey, wire([await create(s)]), "u1");
    await s.sponsor.build(s.player.publicKey, wire([await create(s)]), "u1");
    const f = setup({ noAccount: true, sendFails: true });
    const b = await f.sponsor.build(f.player.publicKey, wire([await create(f)]), "u2");
    await expect(f.sponsor.submit(playerSigns(b, f.player), b.meta, b.mac)).rejects.toMatchObject({ code: "chain" });
    expect(await f.deps.store.used("onboard-user:u2", 100 * 365 * 86_400_000, 1_000_000)).toBe(0);
    expect(await f.deps.store.used("onboard-day", 86_400_000, 1_000_000)).toBe(0);
  });
  it("stops at the daily cap and mails the operators at the alert level, once", async () => {
    const s = setup({ noAccount: true, limits: { onboardPerDay: 3, onboardAlertAt: 2 } });
    const people = [0, 1, 2].map(() => Keypair.generate());
    const run = async (p: Keypair, sub: string) => {
      const b = await s.sponsor.build(p.publicKey, wire([await createAccountIx(s.relayer.publicKey, p.publicKey)]), sub);
      return s.sponsor.submit(playerSigns(b, p), b.meta, b.mac);
    };
    await run(people[0], "a");
    expect(s.onboardingAlerts).toEqual([]);
    await run(people[1], "b");
    await run(people[2], "c");
    expect(s.onboardingAlerts).toEqual([2]);
    const late = Keypair.generate();
    await expect(s.sponsor.build(late.publicKey, wire([await createAccountIx(s.relayer.publicKey, late.publicKey)]), "d")).rejects.toMatchObject({ code: "global-limit" });
  });
  it("the limits are config: a user may get more than one when the founder says so", async () => {
    const s = setup({ noAccount: true, limits: { onboardPerUser: 2 } });
    const b = await s.sponsor.build(s.player.publicKey, wire([await create(s)]), "gen");
    await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac);
    await expect(s.sponsor.build(s.player.publicKey, wire([await create(s)]), "gen")).resolves.toBeTruthy();
  });
  it("is not sponsored when someone else signs for the wallet", async () => {
    const s = setup({ noAccount: true });
    const other = Keypair.generate();
    await expect(s.sponsor.build(other.publicKey, wire([await create(s)]), "x")).rejects.toMatchObject({ code: "bad-signer" });
  });
  it("co-signs with the Invite key only for a wallet that redeemed an Invite", async () => {
    const no = setup({ noAccount: true, invite: { redeemed: false } });
    await expect(no.sponsor.build(no.player.publicKey, wire([await create(no, { invite: no.inviteKey.publicKey })]), "i")).rejects.toMatchObject({ code: "invite-required" });
    const none = setup({ noAccount: true });
    await expect(none.sponsor.build(none.player.publicKey, wire([await create(none, { invite: none.inviteKey.publicKey })]), "i")).rejects.toMatchObject({ code: "bad-accounts" });
    const yes = setup({ noAccount: true, invite: { redeemed: true } });
    const b = await yes.sponsor.build(yes.player.publicKey, wire([await create(yes, { invite: yes.inviteKey.publicKey })]), "i");
    await yes.sponsor.submit(playerSigns(b, yes.player), b.meta, b.mac);
    const tx = yes.sent[0];
    const bytes = tx.message.serialize();
    const keys = tx.message.staticAccountKeys;
    const at = keys.findIndex((k) => k.equals(yes.inviteKey.publicKey));
    expect(nacl.sign.detached.verify(bytes, tx.signatures[at], yes.inviteKey.publicKey.toBytes())).toBe(true);
    expect(nacl.sign.detached.verify(bytes, tx.signatures[0], yes.relayer.publicKey.toBytes())).toBe(true);
  });
});

describe("the rest of sign-up on the sponsor (ticket 18c)", () => {
  it("a Profile for an Account with no Gemas is built and sent", async () => {
    const s = setup({ gemas: 0n });
    const b = await s.sponsor.build(s.player.publicKey, wire([await signUpIx.profile(s.relayer.publicKey, s.player.publicKey)]), "u");
    expect(b.class).toBe("continue");
    expect((await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac)).signature).toBe("sig1");
  });
  it("link_evm needs the Account but not Gemas, and counts against the Account's limits", async () => {
    const s = setup({ gemas: 0n });
    const b = await s.sponsor.build(s.player.publicKey, wire([linkEvmBridgeIx(s.player.publicKey, s.relayer.publicKey)]), "u");
    expect(b.class).toBe("admission");
    await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac);
    const none = setup({ noAccount: true });
    await expect(none.sponsor.build(none.player.publicKey, wire([linkEvmBridgeIx(none.player.publicKey, none.relayer.publicKey)]), "u")).rejects.toMatchObject({ code: "no-account" });
    const capped = setup({ gemas: 0n, limits: { accountSunkTotal: 1_000_000 } });
    await expect(capped.sponsor.build(capped.player.publicKey, wire([linkEvmBridgeIx(capped.player.publicKey, capped.relayer.publicKey)]), "u")).rejects.toMatchObject({ code: "total-limit" });
  });
  it("an Account gets one sponsored link_evm, not one per EVM address it sets", async () => {
    const s = setup({ gemas: 0n });
    await s.sponsor.build(s.player.publicKey, wire([linkEvmBridgeIx(s.player.publicKey, s.relayer.publicKey)]), "u");
    await expect(s.sponsor.build(s.player.publicKey, wire([linkEvmBridgeIx(s.player.publicKey, s.relayer.publicKey)]), "u")).rejects.toMatchObject({ code: "link-limit" });
  });
});
