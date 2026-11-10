import { AnchorProvider, BN, BorshAccountsCoder, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { growIx, joinMatchIx, accountOf, backingPairIx, chunkIx, coreIx, createAccountIx, gameStepIx, key, linkEvmBridgeIx, signUpIx, openMatchIx, playerIx } from "./fixtures";
import { DEFAULT_LIMITS, type Limits } from "./policy";
import { CORE_ID, PROTECTIONS_BYTES, type Ix } from "./rules";
import { Sponsor, accountPda, basketPda, type ChainReads, type SponsorDeps, type WireIx } from "./service";
import { MemoryUsageStore } from "./store";
import { encodeBook, encodeStore, freshClass, lineOf } from "@/lib/chain/basket-fixture";
import { initCkptPageIx } from "@/lib/chain/settle-plan";
import { fp } from "@/lib/chain/book";
import { bookPda, ckptPda, countersPda } from "@/lib/chain/basket";
import { SIM_SOL_MINT, protectionsPda, sourcePda } from "@/lib/chain/native";
import { redeemLineIxs, unlockIxs } from "@/lib/chain/redeem";
import { planExit } from "@/lib/chain/exit-route";
import { getChain } from "@/lib/chain/client";
import { JITOSOL } from "@/lib/chain/stake";
import { createAtaIdempotentIx, tokenAta, STAKE_POOL_PROGRAM_ID, updateStakePoolBalanceIx } from "@/lib/chain/stake-pool";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unlockStakeIx } from "@/lib/chain/stake";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { ChainTransactionFailed } from "./chain-send";
import { recoverCompletions } from "./completion";
import { Assigner, MemoryLeaseStore } from "./assign";
import { MATCH_STATE_FIXTURE } from "./assign-fixture";
import { assignMatchIx } from "./assign-ix";
import { joinMatchIx as joinMatchIxOf } from "@/lib/chain/entry";
import { ComputeBudgetProgram, TransactionMessage } from "@solana/web3.js";
import { GAME_IDS } from "@/lib/chain/games";
import { POT_AT, STORE_HEADER, TICKET_HEAD, TICKET_VERSION } from "@/lib/chain/pot-store";
import { stageEntryIx } from "@/lib/chain/ticket";
import { offerPda } from "@/lib/chain/backing-ix";

const SOL = 1_000_000_000n;
const wire = (ixs: Ix[]): { ixs: WireIx[] } => ({
  ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })),
});
const basketData = (gemas: bigint) => {
  const d = Buffer.alloc(400);
  d.writeBigUInt64LE(gemas, 8 + 40);
  return d;
};

function setup(over: { balance?: bigint; limits?: Partial<Limits>; paused?: boolean; gemas?: bigint; existing?: PublicKey[]; sendFails?: boolean; sendError?: Error; noAccount?: boolean; simulate?: { err?: unknown; extraSpend?: bigint; noLamports?: boolean; raceOnce?: bigint }; invite?: { redeemed: boolean }; epoch?: bigint } = {}) {
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  const game = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
  const sent: VersionedTransaction[] = [];
  const alerts: bigint[] = [];
  const onboardingAlerts: number[] = [];
  const inviteKey = Keypair.generate();
  let balance = over.balance ?? 10n * SOL;
  let raced = false;
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  accounts.set(basketPda(accountPda(player.publicKey)).toBase58(), { owner: CORE_ID, data: basketData(over.gemas ?? 500n) });
  if (!over.noAccount) accounts.set(accountPda(player.publicKey).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  for (const k of over.existing ?? []) accounts.set(k.toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  const chain: ChainReads = {
    getTransaction: async (signature) => {
      const tx = sent.find((t) => bs58.encode(t.signatures[0]) === signature);
      if (!tx) return null;
      return { transaction: { message: tx.message, signatures: [signature] }, meta: {
        err: null, fee: 5000, preBalances: tx.message.staticAccountKeys.map(() => 1),
        postBalances: tx.message.staticAccountKeys.map(() => 0),
      }, slot: 1, blockTime: 1, version: 0 };
    },
    balance: async () => balance,
    rent: async (bytes) => BigInt(bytes + 128) * 6960n,
    account: async (k) => accounts.get(k.toBase58()) ?? null,
    accountsTogether: async (keys) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    epoch: async () => over.epoch ?? 1075n,
    latestBlockhash: async () => "11111111111111111111111111111111",
    // The relayer pays the fee (5,000 + priority) and the receipt's rent: what a Game step is meant to cost.
    simulate: async (tx) => {
      const closes = Buffer.from(tx.message.compiledInstructions.at(-1)!.data).equals(Buffer.from([180, 122, 187, 197, 166, 152, 1, 222]));
      // Another sponsored transaction lands between the balance read and the simulation, once.
      const race = over.simulate?.raceOnce && !raced ? ((raced = true), over.simulate.raceOnce) : 0n;
      return { err: over.simulate?.err ?? null, lamports: over.simulate?.noLamports ? null : balance - 5_000n - 400n - (closes ? 0n : 1_275_080n) - (over.simulate?.extraSpend ?? 0n) - race };
    },
    send: async (raw) => {
      if (over.sendError) throw over.sendError;
      if (over.sendFails) throw new ChainTransactionFailed("custom program error 0x1");
      const tx = VersionedTransaction.deserialize(raw);
      sent.push(tx);
      return "sig" + sent.length;
    },
  };
  let t = 1_000_000;
  const deps: SponsorDeps & { store: MemoryUsageStore } = {
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

async function firstPayout(s: ReturnType<typeof setup>, threePages = false) {
  const position = key(), source = sourcePda(position, 0);
  const disc = (name: string) => Buffer.from(coreIdl.accounts.find((a) => a.name === name)!.discriminator);
  const p = Buffer.alloc(235); p.set(disc("PositionState")); p.fill(7, 9, 41); p.set(accountPda(s.player.publicKey).toBytes(), 41); p.set(SIM_SOL_MINT.toBytes(), 74);
  const src = Buffer.alloc(170); src.set(disc("SourceState")); src.set(position.toBytes(), 9);
  s.accounts.set(position.toBase58(), { owner: CORE_ID, data: p });
  s.accounts.set(source.toBase58(), { owner: CORE_ID, data: src });
  const unpaid = () => ({ ...freshClass(), uncovered: fp(10n), w: fp(10n) });
  const book = encodeBook([freshClass(), threePages ? unpaid() : freshClass(), freshClass(), unpaid(), ...(threePages ? [unpaid()] : [])]);
  book.set(disc("SourceBookHead")); book[9] = 1; book.set(source.toBytes(), 16);
  s.accounts.set(bookPda(source).toBase58(), { owner: CORE_ID, data: book });
  const reader = { getMultipleAccountsInfo: (keys: PublicKey[]) => Promise.all(keys.map((k) => s.deps.chain.account(k))) };
  const h = { line: { side: 1, dueAt: 9n, class: 3, tranche: 0 }, accounts: [] as PublicKey[], source, position, stakeMint: null };
  const ixs = await redeemLineIxs(reader, s.player.publicKey, h, 1n);
  for (const ix of ixs.slice(0, -1)) ix.keys[0].pubkey = s.relayer.publicKey;
  return { ixs, source, position, book };
}

/** A Lock with an open Advance (Debt 0) and no token account for its Player: what an Unlock must set up. */
async function unlockSetup(s: ReturnType<typeof setup>) {
  const { source, position, book } = await firstPayout(s);
  const p = s.accounts.get(position.toBase58())!.data as Buffer;
  p[122] = 1; p.writeUInt32LE(0, 123);
  const reader = { getMultipleAccountsInfo: (keys: PublicKey[]) => Promise.all(keys.map((k) => s.deps.chain.account(k))) };
  const spy = vi.spyOn(getChain(), "base", "get").mockReturnValue(reader as never);
  const ixs = await unlockIxs(s.player.publicKey, { position, openAdvance: 0, stakeRateOpen: 0n, mint: SIM_SOL_MINT });
  spy.mockRestore();
  const route = planExit(ixs, s.player.publicKey, s.relayer.publicKey);
  return { ixs, route, source, position, book };
}

describe("Unlock of a 0-SOL Player whose token account is missing", () => {
  it("is sent by the route as prepared, the relayer paying the token account and checkpoint rent", async () => {
    const s = setup({ gemas: 0n });
    const { route } = await unlockSetup(s);
    expect(route.kind).toBe("prepared");
    expect(route.ixs.length).toBeGreaterThan(1);
    const built = await s.sponsor.build(s.player.publicKey, wire(route.ixs));
    expect(built.class).toBe("exit");
    expect(BigInt(JSON.parse(built.meta).cost)).toBeGreaterThan(2_000_000n);
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent[0].message.staticAccountKeys[0]).toEqual(s.relayer.publicKey);
  });
  it("is refused when the checkpoint is not one the closing Advance's Source needs", async () => {
    const s = setup();
    const { route, source } = await unlockSetup(s);
    const extra = await coreIx("init_ckpt_page", [3, 1], { payer: s.relayer.publicKey, book: bookPda(source), page: ckptPda(source, 3, 1) });
    route.ixs.at(-1)!.keys.push({ pubkey: ckptPda(source, 3, 1), isWritable: true, isSigner: false });
    await expect(s.sponsor.build(s.player.publicKey, wire([extra, ...route.ixs]))).rejects.toMatchObject({ code: "bad-setup" });
  });
  it("is refused for a Source that is not the Position's open Advance", async () => {
    const s = setup();
    const { route, position } = await unlockSetup(s);
    (s.accounts.get(position.toBase58())!.data as Buffer)[122] = 0;
    await expect(s.sponsor.build(s.player.publicKey, wire(route.ixs))).rejects.toMatchObject({ code: "bad-setup" });
  });
});

describe("a staking-token Unlock that carries the stake pool update", () => {
  const live = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
  const pool = (lastUpdate: bigint) => {
    const d = Buffer.from(live);
    d.writeBigUInt64LE(lastUpdate, 274);
    return { owner: STAKE_POOL_PROGRAM_ID, data: d };
  };
  async function stakeUnlock(s: ReturnType<typeof setup>, lastUpdate: bigint) {
    const { position } = await firstPayout(s);
    (s.accounts.get(position.toBase58())!.data as Buffer).set(JITOSOL.mint.toBytes(), 74);
    s.accounts.set(JITOSOL.pool.toBase58(), pool(lastUpdate));
    const update = updateStakePoolBalanceIx(JITOSOL.pool, pool(lastUpdate));
    // the Player already has the token account
    s.accounts.set(tokenAta(s.player.publicKey, JITOSOL.mint).toBase58(), { owner: CORE_ID, data: new Uint8Array(165) });
    return { ixs: [update, unlockStakeIx(s.player.publicKey, position, null, JITOSOL)] };
  }

  it("is admitted and paid for by the relayer while the pool is more than one epoch behind", async () => {
    const s = setup({ gemas: 0n, paused: true });
    const { ixs } = await stakeUnlock(s, 1073n);
    const built = await s.sponsor.build(s.player.publicKey, wire(ixs));
    expect(built.class).toBe("exit");
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent[0].message.staticAccountKeys[0]).toEqual(s.relayer.publicKey);
    expect(s.sent[0].message.compiledInstructions.some((i) => s.sent[0].message.staticAccountKeys[i.programIdIndex].equals(STAKE_POOL_PROGRAM_ID))).toBe(true);
  });
  it("is refused when the pool is current or one epoch behind: the sponsor never pays for a no-op", async () => {
    for (const last of [1075n, 1074n]) {
      const s = setup();
      const { ixs } = await stakeUnlock(s, last);
      await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "bad-setup" });
    }
  });
  it("is refused when the instruction's accounts are not the pool's own", async () => {
    const s = setup();
    const { ixs } = await stakeUnlock(s, 1000n);
    ixs[0].keys[2] = { ...ixs[0].keys[2], pubkey: key() };
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "bad-setup" });
  });
  it("is refused when the Position is not a staking-token Position", async () => {
    const s = setup();
    const { ixs } = await stakeUnlock(s, 1000n);
    const p = [...s.accounts.entries()].find(([, a]) => Buffer.from(a.data.subarray(74, 106)).equals(Buffer.from(JITOSOL.mint.toBytes())))!;
    (p[1].data as Buffer).set(SIM_SOL_MINT.toBytes(), 74);
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "bad-setup" });
  });
});

describe("first payout account funding", () => {
  it("funds all three required landing pages on an extended Source", async () => {
    const s = setup(); const { ixs } = await firstPayout(s, true);
    expect(ixs).toHaveLength(5);
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).resolves.toHaveProperty("class", "exit");
  });
  it("funds a zero-SOL Player's missing ATA and required checkpoint while admissions are paused and exhausted", async () => {
    const s = setup({ paused: true, gemas: 0n, limits: { accountPerDay: 0, globalPerDay: 0 } });
    const { ixs } = await firstPayout(s);
    const built = await s.sponsor.build(s.player.publicKey, wire(ixs));
    expect(built.class).toBe("exit");
    expect(BigInt(JSON.parse(built.meta).cost)).toBeGreaterThan(14_000_000n);
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].message.staticAccountKeys[0]).toEqual(s.relayer.publicKey);
  });
  it("does not gift replacement ATA rent after a successful Player closes the funded account", async () => {
    const s = setup(); const { ixs } = await firstPayout(s);
    const b = await s.sponsor.build(s.player.publicKey, wire(ixs));
    await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac);
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "setup-already-funded" });
    const send = vi.spyOn(s.deps.chain, "send");
    const bare = await s.sponsor.build(s.player.publicKey, wire([ixs.at(-1)!]));
    await s.sponsor.submit(playerSigns(bare, s.player), bare.meta, bare.mac);
    expect(s.sent).toHaveLength(2);
    expect(send).toHaveBeenLastCalledWith(expect.anything(), { failFast: true });
  });
  it("returns the first-use grant after a definitive atomic failure", async () => {
    const s = setup({ sendFails: true }); const { ixs } = await firstPayout(s);
    const b = await s.sponsor.build(s.player.publicKey, wire(ixs));
    await expect(s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac)).rejects.toMatchObject({ code: "chain" });
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).resolves.toHaveProperty("class", "exit");
  });
  it("asks for a fast failure on an ordinary send, and keeps the first-use grant for a setup send that waits for the final answer", async () => {
    const plain = setup(); const { ixs } = await firstPayout(plain);
    const grant = vi.spyOn(plain.deps.chain, "send");
    const b = await plain.sponsor.build(plain.player.publicKey, wire(ixs));
    expect(JSON.parse(b.meta).ataGrant).toBeTruthy();
    await plain.sponsor.submit(playerSigns(b, plain.player), b.meta, b.mac);
    expect(grant).toHaveBeenLastCalledWith(expect.anything(), { failFast: false });
  });
  it("retains the first-use grant after an ambiguous broadcast failure", async () => {
    const s = setup({ sendError: new Error("network timeout") }); const { ixs } = await firstPayout(s);
    const b = await s.sponsor.build(s.player.publicKey, wire(ixs));
    await expect(s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac)).rejects.toMatchObject({ code: "chain" });
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "setup-already-funded" });
  });
  it("rechecks rent plus fees when the relayer balance falls between build and submit", async () => {
    const s = setup(); const { ixs } = await firstPayout(s);
    const b = await s.sponsor.build(s.player.publicKey, wire(ixs));
    s.setBalance(100_000n);
    await expect(s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac)).rejects.toMatchObject({ code: "sponsor-empty" });
    expect(s.sent).toHaveLength(0);
  });
  it("rejects a canonical Player ATA for a different payout mint", async () => {
    const s = setup(); const { ixs } = await firstPayout(s);
    const old = ixs[1].keys[1].pubkey, wrong = tokenAta(s.player.publicKey, JITOSOL.mint);
    ixs[1] = createAtaIdempotentIx(s.relayer.publicKey, s.player.publicKey, JITOSOL.mint);
    for (const k of ixs.at(-1)!.keys) if (k.pubkey.equals(old)) k.pubkey = wrong;
    await expect(s.sponsor.build(s.player.publicKey, wire(ixs))).rejects.toMatchObject({ code: "bad-setup" });
  });
  it("refuses a Source page that is not needed at this landing", async () => {
    const s = setup(); const { ixs, source } = await firstPayout(s);
    const extra = await coreIx("init_ckpt_page", [3, 1], { payer: s.relayer.publicKey, book: bookPda(source), page: ckptPda(source, 3, 1) });
    ixs.at(-1)!.keys.push({ pubkey: ckptPda(source, 3, 1), isWritable: true, isSigner: false });
    await expect(s.sponsor.build(s.player.publicKey, wire([extra, ...ixs]))).rejects.toMatchObject({ code: "bad-setup" });
  });
});

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

describe("the float of a closed Match", () => {
  it("is freed at the next admission, whoever closed the Match", async () => {
    const s = setup();
    const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    const b1 = await s.sponsor.build(s.player.publicKey, wire([open]));
    await s.sponsor.submit(playerSigns(b1, s.player), b1.meta, b1.mac);
    expect(await s.deps.store.held()).toBe(DEFAULT_LIMITS.completionReserve);
    // room for one more admission only if the hold goes
    s.setBalance(DEFAULT_LIMITS.floor + BigInt(JSON.parse(b1.meta).fronted) + DEFAULT_LIMITS.completionReserve + 100_000n);
    const again = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    await expect(s.sponsor.build(s.player.publicKey, wire([again]))).rejects.toMatchObject({ code: "sponsor-paused" });
    // the Match was closed by its Player, not by us: it is gone and the Account's counter is past number 1
    const counters = Buffer.alloc(33);
    counters.writeBigUInt64LE(2n, 9);
    s.accounts.set(PublicKey.findProgramAddressSync([Buffer.from("counters"), accountPda(s.player.publicKey).toBuffer()], CORE_ID)[0].toBase58(), { owner: CORE_ID, data: counters });
    await expect(s.sponsor.build(s.player.publicKey, wire([again]))).resolves.toMatchObject({ class: "admission" });
    expect(await s.deps.store.held()).toBe(0n);
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

describe("a Game's finalize with the relayer as caller (ticket 04)", () => {
  const matchCoder = new Program(coreIdl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
  const arr = (k: PublicKey) => Array.from(k.toBytes());
  /** A MatchState (snake_case, through the real coder) with the given Players. */
  const matchData = async (a: PublicKey, b: PublicKey | null) => {
    const party = (p: PublicKey) => ({ player: arr(p), funder: arr(p), shareBps: 0 });
    const inner = {
      id: { opener: arr(a), n: new BN(5) }, meta: { challenge: false, asset: 0, listed: true }, game: arr(key()), settleAuthority: arr(key()), deploySlot: new BN(1),
      terms: { platformBps: 200, studioBps: 300, studioOwner: null, studioPriority: true }, entry: new BN(500), openedAt: new BN(1), deadline: new BN(2), deadlineAbs: new BN(3),
      a: party(a), b: b ? party(b) : null, potLines: [1, 1], stage: { open: {} }, run: null,
    };
    return Buffer.from(await matchCoder.encode("matchState", { bump: 255, inner, listed: true, listingEpoch: 0, payer: key(), pots: [key(), key()], room: Array.from({ length: 5 }, () => ({ account: arr(PublicKey.default), left: 0 })) }));
  };
  const finalizeIx = (s: ReturnType<typeof setup>, matchState: PublicKey) => gameStepIx(s.game, "finalize", matchState, s.relayer.publicKey);
  /** A Match the Player opened, held by the fake chain. */
  const withMatch = async (over: Parameters<typeof setup>[0] = {}, parties: (p: PublicKey) => [PublicKey, PublicKey | null] = (p) => [p, key()]) => {
    const matchState = key();
    const s = setup(over);
    const [a, b] = parties(s.player.publicKey);
    s.accounts.set(matchState.toBase58(), { owner: CORE_ID, data: await matchData(a, b) });
    return { s, matchState };
  };
  it("is built and sent with the relayer as the only signer and the fee payer: the Player's wallet pays nothing", async () => {
    const { s, matchState } = await withMatch();
    const built = await s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]));
    expect(built.class).toBe("exit");
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(s.sent).toHaveLength(1);
    const keys = s.sent[0].message.staticAccountKeys;
    expect(s.sent[0].message.header.numRequiredSignatures).toBe(1);
    expect(keys[0].equals(s.relayer.publicKey)).toBe(true);
    expect(keys.some((k) => k.equals(s.player.publicKey))).toBe(false);
  });
  it("is also sent for the Player who joined, not only the opener", async () => {
    const { s, matchState } = await withMatch({}, (p) => [key(), p]);
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).resolves.toMatchObject({ class: "exit" });
  });
  it("close_assignment and refund_untabled go the same way; close_assignment needs no rent hold and no daily-cap slot", async () => {
    const { s, matchState } = await withMatch({ limits: { rentExitsPerDay: 1 } });
    const close = gameStepIx(s.game, "close_assignment", matchState, s.relayer.publicKey);
    const refund = gameStepIx(s.game, "refund_untabled", matchState, s.relayer.publicKey);
    await s.sponsor.build(s.player.publicKey, wire([refund]));
    await expect(s.sponsor.build(s.player.publicKey, wire([refund]))).rejects.toMatchObject({ code: "sponsor-empty" });
    await expect(s.sponsor.build(s.player.publicKey, wire([close]))).resolves.toMatchObject({ class: "exit" });
  });
  it("is simulated before it is signed: a step that would fail is refused and does not use up the Match's tries", async () => {
    const { s, matchState } = await withMatch({ simulate: { err: { InstructionError: [2, { Custom: 6037 }] } } });
    for (let i = 0; i < DEFAULT_LIMITS.gameStepsPerMatch + 2; i++) await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "would-fail", status: 409 });
  });
  it("is refused when the simulation shows it would cost the relayer more than the fee and the receipt's rent, or shows nothing", async () => {
    const over = await withMatch({ simulate: { extraSpend: 1_000_000n } });
    await expect(over.s.sponsor.build(over.s.player.publicKey, wire([finalizeIx(over.s, over.matchState)]))).rejects.toMatchObject({ code: "costs-too-much" });
    const blind = await withMatch({ simulate: { noLamports: true } });
    await expect(blind.s.sponsor.build(blind.s.player.publicKey, wire([finalizeIx(blind.s, blind.matchState)]))).rejects.toMatchObject({ code: "costs-too-much" });
  });
  it("gives the Match's tries back when anything after admission fails, not only the simulation", async () => {
    const { s, matchState } = await withMatch();
    const ok = s.deps.lookupTables;
    s.deps.lookupTables = async () => {
      throw new Error("rpc down");
    };
    for (let i = 0; i < DEFAULT_LIMITS.gameStepsPerMatch + 2; i++) await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toThrow("rpc down");
    s.deps.lookupTables = ok;
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).resolves.toMatchObject({ class: "exit" });
  });
  it("is not refused because another sponsored transaction landed while it was measured, but a real overspend still is", async () => {
    const raced = await withMatch({ simulate: { raceOnce: 3_000_000n } });
    await expect(raced.s.sponsor.build(raced.s.player.publicKey, wire([finalizeIx(raced.s, raced.matchState)]))).resolves.toMatchObject({ class: "exit" });
    const drained = await withMatch({ simulate: { extraSpend: 1_000_000n, raceOnce: 3_000_000n } });
    await expect(drained.s.sponsor.build(drained.s.player.publicKey, wire([finalizeIx(drained.s, drained.matchState)]))).rejects.toMatchObject({ code: "costs-too-much" });
  });
  it("holds the relayer to the chain's own receipt rent, read once", async () => {
    const { s, matchState } = await withMatch();
    const built = await s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]));
    expect(BigInt(JSON.parse(built.meta).cost)).toBe(5_000n + 400n + BigInt(123 + 128) * 6960n);
  });
  it("is refused for a Match that is not there, and for a wallet with no Account", async () => {
    const s = setup();
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, key())]))).rejects.toMatchObject({ code: "no-obligation" });
    const { s: n, matchState } = await withMatch({ noAccount: true });
    await expect(n.sponsor.build(n.player.publicKey, wire([finalizeIx(n, matchState)]))).rejects.toMatchObject({ code: "no-account" });
  });
  it("is refused for a Player who is not in the Match, and for a core account that is not a Match", async () => {
    const { s, matchState } = await withMatch({}, () => [key(), key()]);
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "not-your-match", status: 403 });
    const own = accountPda(s.player.publicKey);
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, own)]))).rejects.toMatchObject({ code: "not-your-match" });
  });
  it("is sent at most a few times per Match, so a page cannot repeat it", async () => {
    const { s, matchState } = await withMatch();
    for (let i = 0; i < DEFAULT_LIMITS.gameStepsPerMatch; i++) await s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]));
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "match-limit", status: 429 });
  });
  it("is capped across all Players per day", async () => {
    const { s, matchState } = await withMatch({ limits: { rentExitsPerDay: 1 } });
    await s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]));
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "sponsor-empty" });
  });
  it("never spends what the exit holds promise: it needs the receipt's rent free of holds", async () => {
    const { s, matchState } = await withMatch({ balance: 1_000_000n });
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "sponsor-empty" });
  });
  it("is refused when the Player's own failures have used up their exits", async () => {
    const { s, matchState } = await withMatch({ limits: { exitFailuresPerDay: 0 } });
    await expect(s.sponsor.build(s.player.publicKey, wire([finalizeIx(s, matchState)]))).rejects.toMatchObject({ code: "too-many-failures" });
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
  it("retains app-close accounting through confirmation uncertainty and recovers after restart", async () => {
    const matchState = key();
    const s = setup({ existing: [matchState] });
    await s.deps.store.hold(matchState.toBase58(), 300_000n);
    await s.deps.store.hold("unrelated", 900n);
    const close = await coreIx("close_match", [], { caller: s.relayer.publicKey, matchState, matchPayer: s.relayer.publicKey, potA: key(), potAPayer: s.relayer.publicKey, potB: null, potBPayer: null, sponsor: null });
    const finalized = s.deps.chain.getTransaction;
    s.deps.chain.getTransaction = async () => null;
    const b = await s.sponsor.build(s.player.publicKey, wire([close]));
    await s.sponsor.submit(playerSigns(b, s.player), b.meta, b.mac);
    expect(await s.deps.store.held()).toBe(300_900n);
    // The original Sponsor instance is no longer needed: the durable journal names the signature and generations.
    s.deps.chain.getTransaction = finalized;
    expect(await recoverCompletions(s.deps.store, s.deps.chain)).toBe(1);
    expect(await s.deps.store.held()).toBe(900n);
  });
  it("retains a completion reserve when a broadcast times out and may still land", async () => {
    const s = setup({ sendError: new Error("broadcast timeout") });
    const built = await s.sponsor.build(s.player.publicKey, wire([await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game)]));
    await expect(s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac)).rejects.toMatchObject({ code: "chain" });
    expect(await s.deps.store.held()).toBe(300_000n);
  });
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
    const capped = setup({ gemas: 0n, limits: { accountSunkPerDay: 1_000_000 } });
    await expect(capped.sponsor.build(capped.player.publicKey, wire([linkEvmBridgeIx(capped.player.publicKey, capped.relayer.publicKey)]), "u")).rejects.toMatchObject({ code: "cost-limit" });
  });
  it("an Account gets one sponsored link_evm, not one per EVM address it sets", async () => {
    const s = setup({ gemas: 0n });
    await s.sponsor.build(s.player.publicKey, wire([linkEvmBridgeIx(s.player.publicKey, s.relayer.publicKey)]), "u");
    await expect(s.sponsor.build(s.player.publicKey, wire([linkEvmBridgeIx(s.player.publicKey, s.relayer.publicKey)]), "u")).rejects.toMatchObject({ code: "link-limit" });
  });
});

describe("join and assign in one transaction", () => {
  const withAssigner = (tables: { generation: number; index: number; epoch: bigint }[] = [{ generation: 1, index: 0, epoch: 3n }]) => {
    const s = setup();
    const operator = Keypair.generate();
    const leases = new MemoryLeaseStore();
    s.deps.assigner = new Assigner({ operator, leases, tables: async () => tables, now: () => 1_000_000 });
    const match = key();
    s.accounts.set(match.toBase58(), { owner: CORE_ID, data: MATCH_STATE_FIXTURE });
    return { s, operator, match };
  };
  const join = async (s: ReturnType<typeof setup>, match: PublicKey) => {
    const ix = await joinMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
    ix.keys[9] = { ...ix.keys[9], pubkey: match };
    return ix;
  };

  it("adds the Game's assign_match, signed by the operator, and the relayer pays for it", async () => {
    const { s, operator, match } = withAssigner();
    const built = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
    const last = msg.compiledInstructions.at(-1)!;
    expect(msg.staticAccountKeys[last.programIdIndex].toBase58()).toBe(s.game.toBase58());
    expect(Buffer.from(last.data).subarray(0, 8)).toEqual(Buffer.from([195, 128, 179, 141, 148, 120, 135, 51]));
    expect(msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58())).toEqual(expect.arrayContaining([s.relayer.publicKey, s.player.publicKey, operator.publicKey].map((k) => k.toBase58())));
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    const sent = s.sent[0];
    const bytes = sent.message.serialize();
    sent.message.staticAccountKeys.slice(0, sent.message.header.numRequiredSignatures).forEach((k, i) => expect(nacl.sign.detached.verify(bytes, sent.signatures[i], k.toBytes())).toBe(true));
  });

  it("puts grow_counters in front of a join that reads an old 25-byte counters account, and not when the account is current", async () => {
    const { s, match } = withAssigner();
    const counters = countersPda(accountPda(s.player.publicKey));
    const disc = Buffer.from((coreIdl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === "AccountCounters")!.discriminator);
    const growDisc = Buffer.from((coreIdl.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === "grow_counters")!.discriminator);
    const names = async () => {
      const built = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
      const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
      return msg.compiledInstructions.map((i) => (Buffer.from(i.data).subarray(0, 8).equals(growDisc) ? "grow" : "other"));
    };
    expect(await names()).not.toContain("grow");
    const old = Buffer.alloc(25);
    disc.copy(old);
    s.accounts.set(counters.toBase58(), { owner: CORE_ID, data: old });
    const seen = await names();
    expect(seen.filter((n) => n === "grow")).toHaveLength(1);
    expect(seen.indexOf("grow")).toBeLessThan(seen.lastIndexOf("other") - 0);
  });

  it("sends a join that no longer fits with its assignment on its own, and frees the table (a Backed entry with a seat key)", async () => {
    const { s, match } = withAssigner();
    const seatKey = key();
    const fits = await join(s, match);
    fits.keys[2] = { ...fits.keys[2], pubkey: seatKey };
    const lone = await s.sponsor.build(s.player.publicKey, wire([fits]));
    expect(VersionedMessage.deserialize(Buffer.from(lone.message, "base64")).compiledInstructions.at(-1)!.data.subarray(0, 8)).toEqual(Uint8Array.from([195, 128, 179, 141, 148, 120, 135, 51]));
    // grow_store_sponsored accounts in front stand in for the Backing accounts: too many bytes for the join and its assignment
    const grows = await Promise.all([growIx(s.relayer.publicKey, accountPda(s.player.publicKey)), growIx(s.relayer.publicKey, key()), growIx(s.relayer.publicKey, key())]);
    const crowded = await join(s, match);
    s.tick(100_000);
    const built = await s.sponsor.build(s.player.publicKey, wire([...grows, crowded]));
    const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
    expect(JSON.parse(built.meta).assign).toBeUndefined();
    expect(built.table).toBe(true);
    expect(lone.table).toBeUndefined();
    expect(msg.staticAccountKeys[msg.compiledInstructions.at(-1)!.programIdIndex].equals(CORE_ID)).toBe(true);
    expect(Buffer.from(built.message, "base64").length).toBeLessThanOrEqual(1232);
  });

  it("keeps the table through the start window once sent, so the next join gets another", async () => {
    const { s, match } = withAssigner([{ generation: 1, index: 0, epoch: 3n }, { generation: 1, index: 1, epoch: 3n }]);
    const first = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    await s.sponsor.submit(playerSigns(first, s.player), first.meta, first.mac);
    s.tick(100_000);
    const second = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    const index = (b: { message: string }) => Buffer.from(VersionedMessage.deserialize(Buffer.from(b.message, "base64")).compiledInstructions.at(-1)!.data).readUInt16LE(10);
    expect([index(first), index(second)]).toEqual([0, 1]);
  });

  it("claims the table for the Match in the pool once the join is sent", async () => {
    const { s, match } = withAssigner();
    const claims: [string, number, string][] = [];
    s.deps.assigner = new Assigner({ operator: Keypair.generate(), leases: new MemoryLeaseStore(), tables: async () => [{ generation: 1, index: 0, epoch: 3n }], claim: async (g, p, m) => (claims.push([g, p.index, m]), true), now: () => 1_000_000 });
    const built = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    expect(claims).toEqual([]);
    await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
    expect(claims.length).toBe(1);
    expect(claims[0].slice(0, 2)).toEqual(["block-puzzle", 0]);
    expect(claims[0][2]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}-\d+$/);
  });

  describe("Trading Duel", () => {
    const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
    const duelJoin = async (asset: number) => {
      const { s, match } = withAssigner();
      const decoded = coder.decode("MatchState", MATCH_STATE_FIXTURE) as { inner: { meta: object } };
      s.accounts.set(match.toBase58(), { owner: CORE_ID, data: await coder.encode("MatchState", { ...decoded, inner: { ...decoded.inner, meta: { ...decoded.inner.meta, asset } } }) });
      const ix = await joinMatchIx(s.relayer.publicKey, s.player.publicKey, GAME_IDS["trading-duel"]);
      ix.keys[9] = { ...ix.keys[9], pubkey: match };
      const built = await s.sponsor.build(s.player.publicKey, wire([ix]));
      const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
      return msg.staticAccountKeys[msg.compiledInstructions.at(-1)!.programIdIndex].toBase58();
    };
    it("is assigned in the join when the Match trades a known asset", async () => {
      expect(await duelJoin(2)).toBe(GAME_IDS["trading-duel"].toBase58());
    });
    it("travels alone when the asset is unknown (the Game would refuse the assignment, and the join with it)", async () => {
      expect(await duelJoin(9)).toBe(CORE_ID.toBase58());
    });
  });

  it("sends the join alone when no table is free", async () => {
    const { s, match } = withAssigner([]);
    const built = await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
    expect(msg.header.numRequiredSignatures).toBe(2);
    expect(msg.staticAccountKeys[msg.compiledInstructions.at(-1)!.programIdIndex].toBase58()).toBe(CORE_ID.toBase58());
  });

  it("frees the table when the build is refused", async () => {
    const { s, match } = withAssigner();
    s.deps.limits = { ...s.deps.limits, buildsPerDay: 1 };
    await s.sponsor.build(s.player.publicKey, wire([await join(s, match)]));
    await expect(s.sponsor.build(s.player.publicKey, wire([await join(s, match)]))).rejects.toMatchObject({ code: "account-limit" });
  });

  describe("paid by the Player", () => {
    const poolWith = (s: ReturnType<typeof setup>, claims: number[], tables = [{ generation: 1, index: 0, epoch: 3n }, { generation: 1, index: 1, epoch: 3n }, { generation: 1, index: 2, epoch: 3n }]) => {
      s.deps.assigner = new Assigner({ operator: Keypair.generate(), leases: new MemoryLeaseStore(), tables: async () => tables, claim: async (_g, p) => (claims.push(p.index), true), now: () => 1_000_000 });
    };
    const selfJoin = async (s: ReturnType<typeof setup>, match: PublicKey) => {
      const ix = await join(s, match);
      ix.keys[0] = { ...ix.keys[0], pubkey: s.player.publicKey };
      return wire([ix]);
    };

    it("claims nothing in the pool when it builds the join: the page may never send it", async () => {
      const { s, match } = withAssigner();
      const claims: number[] = [];
      poolWith(s, claims);
      await s.sponsor.buildSelfPaid(s.player.publicKey, await selfJoin(s, match));
      expect(claims).toEqual([]);
    });

    it("a loop of builds by one Player holds one table, claims none", async () => {
      const { s, match } = withAssigner();
      const claims: number[] = [];
      poolWith(s, claims);
      const results = await Promise.allSettled(Array.from({ length: 6 }, async () => s.sponsor.buildSelfPaid(s.player.publicKey, await selfJoin(s, match))));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "join-pending")).toBe(true);
      expect(claims).toEqual([]);
    });

    it("claims the table once the Assignment of the join is on base, and not before", async () => {
      const { s, match } = withAssigner();
      const claims: number[] = [];
      poolWith(s, claims);
      const built = await s.sponsor.buildSelfPaid(s.player.publicKey, await selfJoin(s, match));
      expect(await s.sponsor.confirmSelfPaid(built.meta, built.mac)).toBe(false);
      expect(claims).toEqual([]);
      s.accounts.set(PublicKey.findProgramAddressSync([Buffer.from("assign"), match.toBuffer()], s.game)[0].toBase58(), { owner: s.game, data: Buffer.alloc(40) });
      expect(await s.sponsor.confirmSelfPaid(built.meta, built.mac)).toBe(true);
      expect(claims).toEqual([0]);
      expect(await s.sponsor.confirmSelfPaid(built.meta, "x".repeat(built.mac.length))).toBe(false);
    });

    it("refuses a build for a Match this Player cannot join: their own, or one that is full or not Open", async () => {
      const mc = new BorshAccountsCoder(coreIdl as unknown as Idl);
      const base = mc.decode("MatchState", MATCH_STATE_FIXTURE) as { inner: { a: { player: PublicKey }; b: unknown; stage: object } };
      const withInner = async (name: string, inner: (s: ReturnType<typeof setup>) => object) => {
        const { s, match } = withAssigner();
        poolWith(s, []);
        s.accounts.set(match.toBase58(), { owner: CORE_ID, data: await mc.encode("MatchState", { ...base, inner: { ...base.inner, ...inner(s) } }) });
        return { s, match, name };
      };
      const cases = [
        await withInner("own", (s) => ({ a: { ...base.inner.a, player: Array.from(accountPda(s.player.publicKey).toBytes()) } })),
        await withInner("full", () => ({ b: base.inner.a })),
        await withInner("settling", () => ({ stage: { Settling: {} } })),
      ];
      for (const c of cases) {
        await expect(c.s.sponsor.buildSelfPaid(c.s.player.publicKey, await selfJoin(c.s, c.match)), c.name).rejects.toMatchObject({ code: expect.stringMatching(/no-table|cannot-join/) });
      }
    });

    it("returns the join with the assignment, fee paid by the Player, signed by the operator only", async () => {
      const { s, operator, match } = withAssigner();
      const ix = await join(s, match);
      ix.keys[0] = { ...ix.keys[0], pubkey: s.player.publicKey };
      const { tx } = await s.sponsor.buildSelfPaid(s.player.publicKey, wire([ix]));
      const t = VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
      expect(t.message.staticAccountKeys[0].toBase58()).toBe(s.player.publicKey.toBase58());
      const slots = t.message.staticAccountKeys.slice(0, t.message.header.numRequiredSignatures);
      expect(slots.map((k) => k.toBase58()).sort()).toEqual([s.player.publicKey, operator.publicKey].map((k) => k.toBase58()).sort());
      const at = slots.findIndex((k) => k.equals(operator.publicKey));
      expect(nacl.sign.detached.verify(t.message.serialize(), t.signatures[at], operator.publicKey.toBytes())).toBe(true);
    });

    it("refuses anything but a lone join of the Player's own", async () => {
      const { s, operator, match } = withAssigner();
      const ix = await join(s, match);
      ix.keys[0] = { ...ix.keys[0], pubkey: s.player.publicKey };
      const other = await openMatchIx(s.player.publicKey, s.player.publicKey, s.game);
      await expect(s.sponsor.buildSelfPaid(s.player.publicKey, wire([ix, other]))).rejects.toMatchObject({ code: "bad-request" });
      const named = { ...ix, keys: [...ix.keys, { pubkey: operator.publicKey, isSigner: true, isWritable: false }] };
      await expect(s.sponsor.buildSelfPaid(s.player.publicKey, wire([named]))).rejects.toMatchObject({ code: "bad-request" });
      const relayerPays = await join(s, match);
      await expect(s.sponsor.buildSelfPaid(s.player.publicKey, wire([relayerPays]))).rejects.toMatchObject({ code: "bad-request" });
    });

    it("says so when no table is free, so the page sends the join alone", async () => {
      const { s, match } = withAssigner([]);
      const ix = await join(s, match);
      ix.keys[0] = { ...ix.keys[0], pubkey: s.player.publicKey };
      await expect(s.sponsor.buildSelfPaid(s.player.publicKey, wire([ix]))).rejects.toMatchObject({ code: "no-table" });
    });
  });
});

describe("the sponsored entry's size with a seat key", () => {
  // the real client builder, relayer paying; the Player signs the join and the operator the assignment. A seat key that is not
  // the wallet adds one account key (32 B) and one signature (64 B).
  const sizeOf = (backed: boolean, seatKey: boolean, withAssign = true) => {
    const relayer = key(), opener = key(), backer = key();
    const game = "block-puzzle" as const;
    const join = joinMatchIxOf({
      payer: relayer,
      player: key(),
      match: { opener: key(), n: 3n } as never,
      facts: { game: GAME_IDS[game], openerPlayer: opener, openerFunder: backed ? backer : opener } as never,
      pot: { address: key(), nonce: 4n, lines: 4 } as never,
      backing: backed ? ({ offer: key(), backerAccount: backer } as never) : undefined,
      seatSigner: seatKey ? key() : undefined,
    });
    const assign = assignMatchIx(game, { operator: key(), match: join.keys[9].pubkey, accountA: opener, accountB: key(), pick: { generation: 1, index: 0, epoch: 3n } });
    const message = new TransactionMessage({
      payerKey: relayer,
      recentBlockhash: key().toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), join, ...(withAssign ? [assign] : [])],
    }).compileToV0Message([]);
    return new VersionedTransaction(message).serialize().length;
  };

  it("a seat key adds 96 bytes; plain join + assignment still fits without a lookup table, Backed needs one", () => {
    const sizes = { plain: sizeOf(false, false), plainSeat: sizeOf(false, true), backed: sizeOf(true, false), backedSeat: sizeOf(true, true) };
    console.info("sponsored entry bytes, no lookup table", JSON.stringify(sizes));
    expect(sizes.plainSeat - sizes.plain).toBe(96);
    expect(sizes.backedSeat - sizes.backed).toBe(96);
    expect(sizes.plainSeat).toBeLessThanOrEqual(1232);
  });

  // The Backed entry with a seat key is 1,421 B with its assignment: the sponsor sends the join alone and the keeper assigns the table.
  it("a Backed join with a seat key fits on its own", () => {
    const alone = sizeOf(true, true, false);
    console.info("backed join + seat key, no assignment, bytes", alone);
    expect(sizeOf(true, true)).toBeGreaterThan(1232);
    expect(alone).toBeLessThanOrEqual(1232);
  });
});

describe("seat keys on the sponsor (ticket 10)", () => {
  const matchCoder = new Program(coreIdl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
  const arr = (k: PublicKey) => Array.from(k.toBytes());
  type Side = { account: PublicKey; seat: PublicKey };
  /** A MatchState (through the real coder) whose sides name an Account and its seat key. */
  const matchData = async (a: Side, b: Side | null, stage: object = { open: {} }, game: PublicKey = key(), o: { run?: object; pots?: [PublicKey, PublicKey] } = {}) => {
    const party = (p: Side) => ({ player: arr(p.account), funder: arr(p.account), shareBps: 0, signer: arr(p.seat) });
    const inner = {
      id: { opener: arr(a.account), n: new BN(5) }, meta: { challenge: false, asset: 0, listed: true }, game: arr(game), settleAuthority: arr(key()), deploySlot: new BN(1),
      terms: { platformBps: 200, studioBps: 300, studioOwner: null, studioPriority: true }, entry: new BN(500), openedAt: new BN(1), deadline: new BN(2), deadlineAbs: new BN(3),
      a: party(a), b: b ? party(b) : null, potLines: [1, 1], stage, run: o.run ?? null,
    };
    return Buffer.from(await matchCoder.encode("matchState", { bump: 255, inner, listed: true, listingEpoch: 0, payer: key(), pots: o.pots ?? [key(), key()], room: Array.from({ length: 5 }, () => ({ account: arr(PublicKey.default), left: 0 })) }));
  };
  /** Ana (the setup's Player) is side A with seat key `ana`; Ben is side B with `ben`. */
  async function world(stage?: object) {
    const s = setup();
    const ana = key(), ben = key(), match = key();
    s.accounts.set(match.toBase58(), { owner: CORE_ID, data: await matchData({ account: accountPda(s.player.publicKey), seat: ana }, { account: key(), seat: ben }, stage) });
    return { s, ana, ben, match };
  }
  const seat = (signer: PublicKey, match: PublicKey) => ({ kind: "seat", signer, match }) as const;

  it("builds a Game step and the Match's finish for the seat key the Match names for this Account", async () => {
    const { s, ana, match } = await world();
    const finalize = gameStepIx(s.game, "finalize", match, s.relayer.publicKey);
    await expect(s.sponsor.build(s.player.publicKey, wire([finalize]), null, seat(ana, match))).resolves.toMatchObject({ class: "exit" });
    const chunk = await chunkIx(s.relayer.publicKey, match);
    await expect(s.sponsor.build(s.player.publicKey, wire([chunk]), null, seat(ana, match))).resolves.toMatchObject({ class: "exit" });
  });

  it("refuses the opponent's seat key, a key from another Match and a stranger's key", async () => {
    const { s, ben, match } = await world();
    const finalize = gameStepIx(s.game, "finalize", match, s.relayer.publicKey);
    for (const wrong of [ben, key()]) {
      await expect(s.sponsor.build(s.player.publicKey, wire([finalize]), null, seat(wrong, match))).rejects.toMatchObject({ code: "not-your-seat-key" });
    }
    // Another wallet's request with the key Ana's Match names for Ana.
    const other = await world();
    other.s.accounts.set(match.toBase58(), s.accounts.get(match.toBase58())!);
    const otherFinalize = gameStepIx(other.s.game, "finalize", match, other.s.relayer.publicKey);
    await expect(other.s.sponsor.build(other.s.player.publicKey, wire([otherFinalize]), null, seat(other.ana, match))).rejects.toMatchObject({ code: "not-your-seat-key" });
    // A stranger's wallet with a key the Match names for someone else.
    const stranger = setup();
    stranger.accounts.set(match.toBase58(), s.accounts.get(match.toBase58())!);
    const strangerFinalize = gameStepIx(stranger.game, "finalize", match, stranger.relayer.publicKey);
    await expect(stranger.sponsor.build(stranger.player.publicKey, wire([strangerFinalize]), null, seat(ben, match))).rejects.toMatchObject({ code: "not-your-seat-key" });
  });

  it("refuses a request whose Match is not the one in the transaction", async () => {
    const { s, ana, match } = await world();
    const finalize = gameStepIx(s.game, "finalize", match, s.relayer.publicKey);
    await expect(s.sponsor.build(s.player.publicKey, wire([finalize]), null, seat(ana, key()))).rejects.toMatchObject({ code: "bad-request" });
  });

  it("cancels (refund_match) signed by the opener's seat key itself, as the app sends it; a stranger as caller is still refused", async () => {
    const { s, ana, match } = await world();
    const r = s.relayer.publicKey;
    const refundBy = (caller: PublicKey) => coreIx("refund_match", [], { caller, payer: r, gameProgram: s.game, programData: key(), gameRecord: key(), matchState: match, openerProtections: null });
    await expect(s.sponsor.build(s.player.publicKey, wire([await refundBy(ana)]), null, seat(ana, match))).resolves.toMatchObject({ class: "exit" });
    // a key that signs but is not the one the request was checked for needs an Account of its own
    await expect(s.sponsor.build(s.player.publicKey, wire([await refundBy(key())]), null, seat(ana, match))).rejects.toMatchObject({ code: "no-account" });
  });

  it("cancels (refund_match) only for the opener side's key", async () => {
    const { s, ana, ben, match } = await world();
    const r = s.relayer.publicKey;
    const refund = await coreIx("refund_match", [], { caller: r, payer: r, gameProgram: s.game, programData: key(), gameRecord: key(), matchState: match, openerProtections: null });
    await expect(s.sponsor.build(s.player.publicKey, wire([refund]), null, seat(ana, match))).resolves.toMatchObject({ class: "exit" });
    // The joiner's key may finish a Match but cannot cancel the opener's side.
    const joiner = setup();
    joiner.accounts.set(match.toBase58(), { owner: CORE_ID, data: await matchData({ account: key(), seat: key() }, { account: accountPda(joiner.player.publicKey), seat: ben }) });
    await expect(joiner.sponsor.build(joiner.player.publicKey, wire([refund]), null, seat(ben, match))).rejects.toMatchObject({ code: "not-your-seat-key" });
  });

  describe("checkpoint pages a seat key asks for", () => {
    /** A valid book for `source` (every class fresh): its class 1 and 3 page 0 are pages a fee cut may write. */
    const bookOf = (s: ReturnType<typeof setup>, source: PublicKey) => {
      const book = encodeBook([freshClass(), freshClass(), freshClass(), freshClass()]);
      book.set(Buffer.from(coreIdl.accounts.find((a) => a.name === "SourceBookHead")!.discriminator));
      book[9] = 1;
      book.set(source.toBytes(), 16);
      s.accounts.set(bookPda(source).toBase58(), { owner: CORE_ID, data: book });
    };
    const pagesOf = (s: ReturnType<typeof setup>, source: PublicKey) => [1, 3].map((cls) => initCkptPageIx(s.relayer.publicKey, source, cls, 0));
    /** Ana lost: the Match settles, and its first phase cuts the fees from her Pot's one line, drawn from `source`. */
    async function settling(source: PublicKey) {
      const s = setup();
      const ana = key(), ben = key(), match = key(), potA = key();
      const pot = Buffer.concat([Buffer.alloc(POT_AT), encodeStore([lineOf({ source, amount: 500n })]).subarray(8)]);
      s.accounts.set(potA.toBase58(), { owner: CORE_ID, data: pot });
      const win = { win: { winner: 1 } };
      const run = {
        kind: win, receipt: { id: { opener: arr(accountPda(s.player.publicKey)), n: new BN(5) }, kind: win, at: new BN(1) }, fees: [new BN(10), new BN(15), new BN(5)],
        phases: [{ cuts: [0] }, { back: [1] }, { surplus: { from: 0, to: 1 } }, { back: [0] }], nPhases: 3, phaseI: 0, lineI: 0,
        cutLeft: [[new BN(10), new BN(15), new BN(5)], [new BN(0), new BN(0), new BN(0)]], playerLeft: new BN(0), chunks: 0, steps: 0,
      };
      s.accounts.set(match.toBase58(), { owner: CORE_ID, data: await matchData({ account: accountPda(s.player.publicKey), seat: ana }, { account: key(), seat: ben }, { settling: {} }, key(), { run, pots: [potA, key()] }) });
      return { s, ana, match };
    }

    it("builds the pages the Match's fee cut will write, from the Source of the loser's line", async () => {
      const source = key();
      const { s, ana, match } = await settling(source);
      bookOf(s, source);
      await expect(s.sponsor.build(s.player.publicKey, wire(pagesOf(s, source)), null, seat(ana, match))).resolves.toMatchObject({ class: "exit" });
    });

    it("refuses pages of a book the Match never cuts, though the book could use them, and pages of a Match with no run", async () => {
      const source = key(), other = key();
      const { s, ana, match } = await settling(source);
      bookOf(s, source);
      bookOf(s, other);
      await expect(s.sponsor.build(s.player.publicKey, wire(pagesOf(s, other)), null, seat(ana, match))).rejects.toMatchObject({ code: "not-this-match" });
      await expect(s.sponsor.build(s.player.publicKey, wire([...pagesOf(s, source), ...pagesOf(s, other)]), null, seat(ana, match))).rejects.toMatchObject({ code: "not-this-match" });
      // The same pages through the wallet keep the wallet's own rules (the book needs them).
      await expect(s.sponsor.build(s.player.publicKey, wire(pagesOf(s, other)))).resolves.toMatchObject({ class: "exit" });
      const open = await world();
      bookOf(open.s, source);
      await expect(open.s.sponsor.build(open.s.player.publicKey, wire(pagesOf(open.s, source)), null, seat(open.ana, open.match))).rejects.toMatchObject({ code: "not-this-match" });
    });
  });

  it("never builds what moves value or enters: a seat key gets wallet-only for the rest", async () => {
    const { s, ana, match } = await world();
    const p = s.player.publicKey;
    const wallets = [playerIx.redeem(p), playerIx.unlock(p), playerIx.returnOwn(p), playerIx.claimFreeYield(p), playerIx.cancelRequest(p), playerIx.takeNativeAdvance(p), playerIx.requestInstantRedeem(p)];
    for (const ix of wallets) await expect(s.sponsor.build(p, wire([await ix]), null, seat(ana, match))).rejects.toMatchObject({ code: "wallet-only" });
    const open = await openMatchIx(s.relayer.publicKey, p, s.game);
    await expect(s.sponsor.build(p, wire([open]), null, seat(ana, match))).rejects.toMatchObject({ code: "wallet-only" });
    const join = await joinMatchIx(s.relayer.publicKey, p, s.game);
    await expect(s.sponsor.build(p, wire([join]), null, seat(ana, match))).rejects.toMatchObject({ code: "wallet-only" });
    await expect(s.sponsor.buildSelfPaid(p, wire([join]), null, seat(ana, match))).rejects.toMatchObject({ code: "wallet-only" });
  });

  describe("the table of a join that went out without one", () => {
    const joined = async (over: { claims?: string[] } = {}) => {
      const s = setup();
      const ana = key(), ben = key(), match = key();
      s.deps.assigner = new Assigner({ operator: Keypair.generate(), leases: new MemoryLeaseStore(), tables: async () => [{ generation: 1, index: 0, epoch: 3n }], claim: async (g, p, m) => (over.claims?.push(`${g}/${p.index}/${m}`), true), now: () => 1_000_000 });
      s.accounts.set(match.toBase58(), { owner: CORE_ID, data: await matchData({ account: key(), seat: key() }, { account: accountPda(s.player.publicKey), seat: ana }, { active: {} }, s.game) });
      return { s, ana, ben, match };
    };
    it("builds the operator's assign_match alone, claims the table when sent, and needs no keeper", async () => {
      const claims: string[] = [];
      const { s, ana, match } = await joined({ claims });
      const built = await s.sponsor.buildTable(s.player.publicKey, match, seat(ana, match));
      const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
      expect(msg.header.numRequiredSignatures).toBe(2);
      expect(Buffer.from(msg.compiledInstructions.at(-1)!.data).subarray(0, 8)).toEqual(Buffer.from([195, 128, 179, 141, 148, 120, 135, 51]));
      console.info("assignment-only transaction bytes", new VersionedTransaction(msg).serialize().length);
      expect(claims).toEqual([]);
      await s.sponsor.submit(playerSigns(built, s.player), built.meta, built.mac);
      expect(s.sent).toHaveLength(1);
      expect(claims[0]).toMatch(/^block-puzzle\/0\/[1-9A-HJ-NP-Za-km-z]{32,44}-5$/);
    });
    it("is also open to the wallet, and refuses the other side's key, a stranger and a Match that already has its table", async () => {
      const { s, ana, ben, match } = await joined();
      await expect(s.sponsor.buildTable(s.player.publicKey, match)).resolves.toMatchObject({ class: "exit" });
      s.tick(100_000);
      for (const wrong of [ben, key()]) await expect(s.sponsor.buildTable(s.player.publicKey, match, seat(wrong, match))).rejects.toMatchObject({ code: "not-your-seat-key" });
      await expect(s.sponsor.buildTable(s.player.publicKey, match, seat(ana, key()))).rejects.toMatchObject({ code: "not-your-seat-key" });
      const stranger = setup();
      stranger.deps.assigner = s.deps.assigner;
      stranger.accounts.set(match.toBase58(), s.accounts.get(match.toBase58())!);
      await expect(stranger.sponsor.buildTable(stranger.player.publicKey, match)).rejects.toMatchObject({ code: "not-your-match" });
      await expect(s.sponsor.buildTable(s.player.publicKey, match, { kind: "token" })).rejects.toMatchObject({ code: "wallet-only" });
      s.accounts.set(PublicKey.findProgramAddressSync([Buffer.from("assign"), match.toBuffer()], s.game)[0].toBase58(), { owner: s.game, data: Buffer.alloc(40) });
      await expect(s.sponsor.buildTable(s.player.publicKey, match)).rejects.toMatchObject({ code: "assigned" });
    });
    it("says so when no table is free", async () => {
      const { s, match } = await joined();
      s.deps.assigner = new Assigner({ operator: Keypair.generate(), leases: new MemoryLeaseStore(), tables: async () => [], now: () => 1_000_000 });
      await expect(new Sponsor(s.deps).buildTable(s.player.publicKey, match)).rejects.toMatchObject({ code: "no-table" });
    });
  });

  describe("the entry, vouched for by the Privy login alone", () => {
    it("builds an entry that names a seat key, and the seat key's signature is required by submit", async () => {
      const s = setup();
      const seatKp = Keypair.generate();
      const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game, { seatSigner: seatKp.publicKey });
      const built = await s.sponsor.build(s.player.publicKey, wire([open]), "did:privy:ana", { kind: "token" });
      expect(built.class).toBe("admission");
      const message = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
      const walletOnly = new VersionedTransaction(message);
      walletOnly.sign([s.player]);
      await expect(s.sponsor.submit(Buffer.from(walletOnly.serialize()).toString("base64"), built.meta, built.mac)).rejects.toMatchObject({ code: "unsigned" });
      const both = new VersionedTransaction(message);
      both.sign([s.player, seatKp]);
      await expect(s.sponsor.submit(Buffer.from(both.serialize()).toString("base64"), built.meta, built.mac)).resolves.toMatchObject({ signature: "sig1" });
    });

    it("refuses anything but an entry, for the Account's own address or any other", async () => {
      const s = setup();
      const p = s.player.publicKey;
      for (const ix of [playerIx.redeem(p), playerIx.unlock(p), playerIx.takeNativeAdvance(p)]) {
        await expect(s.sponsor.build(p, wire([await ix]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "wallet-only" });
      }
      await expect(s.sponsor.build(p, wire([await chunkIx(s.relayer.publicKey, key())]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "wallet-only" });
      const signUp = await createAccountIx(s.relayer.publicKey, p, { sponsored: true });
      await expect(s.sponsor.build(p, wire([signUp]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "wallet-only" });
    });

    it("counts the build against the Privy user, not the Account whose address it names", async () => {
      const s = setup({ limits: { buildsPerDay: 1 } });
      const open = await openMatchIx(s.relayer.publicKey, s.player.publicKey, s.game);
      await s.sponsor.build(s.player.publicKey, wire([open]), "did:privy:mallory", { kind: "token" });
      await expect(s.sponsor.build(s.player.publicKey, wire([open]), "did:privy:mallory", { kind: "token" })).rejects.toMatchObject({ code: "account-limit" });
      // Ana's own wallet-signed build is untouched by Mallory's.
      await expect(s.sponsor.build(s.player.publicKey, wire([open]), "did:privy:ana")).resolves.toMatchObject({ class: "admission" });
    });
  });
});

describe("a first Break for a Player with no SOL (keeper diet ticket 27)", () => {
  const rent = BigInt(PROTECTIONS_BYTES + 128) * 6960n; // the test chain's rent()
  const topUp = async (s: ReturnType<typeof setup>, lamports = rent): Promise<Ix[]> => {
    const t = SystemProgram.transfer({ fromPubkey: s.relayer.publicKey, toPubkey: s.player.publicKey, lamports });
    return [{ programId: t.programId, keys: t.keys, data: t.data }, await coreIx("set_break", [3], { ownerAuthority: s.player.publicKey })];
  };
  it("builds: the relayer sends the rent and pays the fee", async () => {
    const s = setup();
    const b = await s.sponsor.build(s.player.publicKey, wire(await topUp(s)));
    const msg = VersionedMessage.deserialize(Buffer.from(b.message, "base64"));
    expect(msg.staticAccountKeys[0].equals(s.relayer.publicKey)).toBe(true);
    expect(msg.compiledInstructions.length).toBe(4); // compute limit, price, transfer, set_break
  });
  it("is refused unless the amount is exactly the cluster's rent for a Protections account", async () => {
    const s = setup();
    await expect(s.sponsor.build(s.player.publicKey, wire(await topUp(s, rent + 1n)))).rejects.toMatchObject({ code: "bad-topup" });
    await expect(s.sponsor.build(s.player.publicKey, wire(await topUp(s, rent - 1n)))).rejects.toMatchObject({ code: "bad-topup" });
  });
  it("is refused when the Account already has a Protections account: the rent is a one-time gift", async () => {
    const s = setup();
    s.accounts.set(protectionsPda(accountPda(s.player.publicKey)).toBase58(), { owner: CORE_ID, data: new Uint8Array(145) });
    await expect(s.sponsor.build(s.player.publicKey, wire(await topUp(s)))).rejects.toMatchObject({ code: "has-protections" });
  });
  it("is refused for a wallet with no Account: nothing to protect", async () => {
    const s = setup({ noAccount: true });
    await expect(s.sponsor.build(s.player.publicKey, wire(await topUp(s)))).rejects.toMatchObject({ code: "no-account" });
  });
  it("is built once at a time: a second build before the first can have landed is refused, a later one is not", async () => {
    const s = setup();
    await s.sponsor.build(s.player.publicKey, wire(await topUp(s)));
    await expect(s.sponsor.build(s.player.publicKey, wire(await topUp(s)))).rejects.toMatchObject({ code: "topup-limit" });
    s.tick(16 * 60_000);
    await s.sponsor.build(s.player.publicKey, wire(await topUp(s)));
  });
});

describe("an Entry Ticket staged by its seat key", () => {
  // the head as pots.rs lays it out: version 2, kind entry, open, the Account at 8, the seat key at 152
  const ticketData = (account: PublicKey, seat: PublicKey, kind = 0) => {
    const head = Buffer.alloc(TICKET_HEAD);
    head[0] = TICKET_VERSION;
    head[2] = kind;
    head.set(account.toBytes(), 8);
    head.set(seat.toBytes(), 152);
    return new Uint8Array(Buffer.concat([Buffer.alloc(8), head, Buffer.alloc(STORE_HEADER)]));
  };
  function world(recorded: (s: ReturnType<typeof setup>) => { account: PublicKey; seat: PublicKey; kind?: number }) {
    const s = setup();
    const seat = key();
    const owner = accountPda(s.player.publicKey);
    const ticket = key();
    const r = recorded(s);
    s.accounts.set(ticket.toBase58(), { owner: CORE_ID, data: ticketData(r.account, r.seat ?? seat, r.kind) });
    return { s, ix: (signer: PublicKey) => stageEntryIx(signer, owner, ticket, 4, []) };
  }

  it("builds for the seat key Ana's Ticket recorded, without a wallet signature", async () => {
    const seat = key();
    const { s, ix } = world((s) => ({ account: accountPda(s.player.publicKey), seat }));
    await expect(s.sponsor.build(s.player.publicKey, wire([ix(seat)]), "did:privy:ana", { kind: "token" })).resolves.toMatchObject({ class: "continue" });
  });
  it("refuses a key the Ticket did not record, the seat key of Ben's Ticket, and a Backing Ticket", async () => {
    const seat = key();
    const stranger = world((s) => ({ account: accountPda(s.player.publicKey), seat }));
    await expect(stranger.s.sponsor.build(stranger.s.player.publicKey, wire([stranger.ix(key())]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "no-account" });
    const bens = world(() => ({ account: key(), seat }));
    await expect(bens.s.sponsor.build(bens.s.player.publicKey, wire([bens.ix(seat)]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "no-account" });
    const backing = world((s) => ({ account: accountPda(s.player.publicKey), seat, kind: 1 }));
    await expect(backing.s.sponsor.build(backing.s.player.publicKey, wire([backing.ix(seat)]), "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "no-account" });
  });
});

describe("a Backing Ticket staged by the Requester's seat key", () => {
  // Bob backs Ana: Ana opened Bob's Backing Ticket 4 for Offer 7 and named her seat key; her seat key stages the rest.
  const TICKET = 4n;
  const offerCoder = new BorshAccountsCoder(coreIdl as unknown as Idl);
  const headOf = (backer: PublicKey, seat: PublicKey, nonce: bigint) => {
    const head = Buffer.alloc(TICKET_HEAD);
    head[0] = TICKET_VERSION;
    head[2] = 1;
    head.set(backer.toBytes(), 8);
    head.writeBigUInt64LE(nonce, 104);
    head.set(seat.toBytes(), 152);
    return new Uint8Array(Buffer.concat([Buffer.alloc(8), head, Buffer.alloc(STORE_HEADER)]));
  };
  const offerData = (o: { backer: PublicKey; nonce: bigint; player: PublicKey; ticketNonce: bigint | null }) =>
    offerCoder.encode("OfferState", {
      bump: 255,
      nonce: new BN(o.nonce.toString()),
      inner: {
        backer: Array.from(o.backer.toBytes()),
        game: Array.from(GAME_IDS.holdem.toBytes()),
        entry: new BN(500),
        player_share_bps: 4_000,
        request: Array.from(key().toBytes()),
        status: { Accepted: {} },
        expires_at: new BN(0),
        use_by: new BN(2_000_000_000),
        player: Array.from(o.player.toBytes()),
        ticket_open: o.ticketNonce !== null,
        counted_in: new BN(0),
        ticket_nonce: o.ticketNonce === null ? null : new BN(o.ticketNonce.toString()),
      },
    });
  function world() {
    const s = setup();
    const seat = key();
    const bob = key();
    const ticket = key();
    s.accounts.set(ticket.toBase58(), { owner: CORE_ID, data: headOf(bob, seat, TICKET) });
    const offerAt = async (nonce: bigint, o: { player?: PublicKey; ticketNonce?: bigint | null; at?: PublicKey } = {}) => {
      const address = o.at ?? offerPda(bob, nonce);
      const ticketNonce = o.ticketNonce === undefined ? TICKET : o.ticketNonce;
      s.accounts.set(address.toBase58(), { owner: CORE_ID, data: await offerData({ backer: bob, nonce, player: o.player ?? accountPda(s.player.publicKey), ticketNonce }) });
      return address;
    };
    const stage = (asker: PublicKey, signer: PublicKey, offer?: PublicKey) =>
      s.sponsor.build(asker, { ...wire([stageEntryIx(signer, bob, ticket, 4, [])]), ...(offer ? { offer: offer.toBase58() } : {}) }, "did:privy:ana", { kind: "token" });
    return { s, seat, offerAt, stage };
  }

  it("builds for Ana's seat key when the request names the Offer that opened the Ticket for her", async () => {
    const w = world();
    const offer = await w.offerAt(7n);
    await expect(w.stage(w.s.player.publicKey, w.seat, offer)).resolves.toMatchObject({ class: "continue" });
  });

  it("refuses a stranger's key, Ana's key asked for by another Player, and a request naming no Offer", async () => {
    const w = world();
    const offer = await w.offerAt(7n);
    await expect(w.stage(w.s.player.publicKey, key(), offer)).rejects.toMatchObject({ code: "no-account" });
    // Cy has an Account of his own, but the Offer is Ana's: the free step would count against the wrong Player
    const cy = Keypair.generate().publicKey;
    w.s.accounts.set(accountPda(cy).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
    await expect(w.stage(cy, w.seat, offer)).rejects.toMatchObject({ code: "no-account" });
    await expect(w.stage(w.s.player.publicKey, w.seat)).rejects.toMatchObject({ code: "no-account" });
  });

  it("refuses a hint that is not this Ticket's Offer: another Ticket's, one with no Ticket open, a copy away from its address", async () => {
    const w = world();
    await expect(w.stage(w.s.player.publicKey, w.seat, await w.offerAt(8n, { ticketNonce: TICKET + 1n }))).rejects.toMatchObject({ code: "no-account" });
    await expect(w.stage(w.s.player.publicKey, w.seat, await w.offerAt(9n, { ticketNonce: null }))).rejects.toMatchObject({ code: "no-account" });
    await expect(w.stage(w.s.player.publicKey, w.seat, await w.offerAt(7n, { at: key() }))).rejects.toMatchObject({ code: "no-account" });
    await expect(w.stage(w.s.player.publicKey, w.seat, key())).rejects.toMatchObject({ code: "no-account" });
  });

  it("refuses a hint that is not an address", async () => {
    const w = world();
    await expect(w.s.sponsor.build(w.s.player.publicKey, { ...wire([]), offer: "not a key" }, "did:privy:ana", { kind: "token" })).rejects.toMatchObject({ code: "bad-request" });
  });
});
