import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { releaseClosedHolds, type ClosureReads } from "./closure";
import { completionEffects, completionInput, completionStore, holdSeeds, type HoldSeed } from "./completion";
import { accountOf, coreIx, joinMatchIx, key, openMatchIx, pda } from "./fixtures";
import { CORE_ID } from "./rules";
import { MemoryUsageStore } from "./store";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const payer = Keypair.generate();

/** A counters account: discriminator, bump, next_match, open_matches, open_offers, next_ticket. */
const counters = (nextMatch: bigint, nextTicket: bigint, bytes = 33) => {
  const d = Buffer.alloc(bytes);
  d.writeBigUInt64LE(nextMatch, 9);
  if (bytes >= 33) d.writeBigUInt64LE(nextTicket, 25);
  return { owner: CORE_ID, data: d };
};
const countersPda = (account: PublicKey) => pda([Buffer.from("counters"), account.toBuffer()]);
const present = { owner: CORE_ID, data: new Uint8Array(40) };

/** A chain whose accounts the test sets; each read is one call, like getMultipleAccounts. */
function chainOf(accounts: Map<string, { owner: PublicKey; data: Uint8Array } | null>): ClosureReads & { calls: number } {
  const c = { calls: 0, accountsTogether: async (keys: PublicKey[]) => { c.calls++; return keys.map((k) => accounts.get(k.toBase58()) ?? null); } };
  return c;
}

async function admit(store: MemoryUsageStore, ix: Awaited<ReturnType<typeof openMatchIx>>, seeds: Record<string, HoldSeed>) {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: key().toBase58(), instructions: [new TransactionInstruction({ ...ix, data: Buffer.from(ix.data) })] }).compileToV0Message());
  tx.sign([payer]);
  const input = completionInput(tx, completionEffects([ix]), 300_000n, seeds);
  await store.prepareCompletion(input);
  await store.finishCompletion(input.signature, true);
}

describe("releasing holds whose address was closed", () => {
  const ana = Keypair.generate().publicKey;
  const anaAccount = accountOf(ana);
  const match = key();
  const seed: HoldSeed = { kind: "match", account: anaAccount.toBase58(), n: "4" };
  async function held() {
    const store = new MemoryUsageStore();
    await admit(store, await openMatchIx(payer.publicKey, ana, key(), { matchState: match }), { [match.toBase58()]: seed });
    return store;
  }

  it("frees the reserve of a Match that is absent while Ana's counter is past its number, whoever closed it", async () => {
    const store = await held();
    expect(await store.held()).toBe(300_000n);
    const chain = chainOf(new Map([[countersPda(anaAccount).toBase58(), counters(5n, 0n)]]));
    expect(await releaseClosedHolds(store, chain)).toBe(1);
    expect(await store.held()).toBe(0n);
    expect(chain.calls).toBe(1);
  });

  it("keeps it while the Match exists, or its creation has not landed, or the counter cannot be read", async () => {
    const store = await held();
    const c = countersPda(anaAccount).toBase58();
    // present: not closed yet
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(5n, 0n)], [match.toBase58(), present]])))).toBe(0);
    // counter still at n: the creating transaction has not landed
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(4n, 0n)]])))).toBe(0);
    // no counters, or the shorter layout of before the upgrade: nothing is proved
    expect(await releaseClosedHolds(store, chainOf(new Map()))).toBe(0);
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(9n, 0n, 25)]])))).toBe(0);
    // lamports sent to the empty address do not make it a Core account
    expect(await store.held()).toBe(300_000n);
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(5n, 0n)], [match.toBase58(), { owner: PublicKey.default, data: new Uint8Array() }]])))).toBe(1);
  });

  it("uses next_ticket for a Ticket or Pot and never the Match counter", async () => {
    const store = new MemoryUsageStore();
    const ticket = key();
    const tseed: HoldSeed = { kind: "ticket", account: anaAccount.toBase58(), n: "2" };
    await admit(store, await coreIx("open_ticket", [new BN(2), { entry: {} }, key(), new BN(500), 2], { payer: payer.publicKey, authority: ana, owner: accountOf(ana), ticket, offer: null, sponsor: null }), { [ticket.toBase58()]: tseed });
    const c = countersPda(anaAccount).toBase58();
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(99n, 2n)]])))).toBe(0);
    expect(await releaseClosedHolds(store, chainOf(new Map([[c, counters(0n, 3n)]])))).toBe(1);
  });

  it("never deletes a newer hold on a reused address", async () => {
    const store = await held();
    const [old] = await store.closureCandidates();
    await store.release(match.toBase58());
    await admit(store, await openMatchIx(payer.publicKey, ana, key(), { matchState: match }), { [match.toBase58()]: { ...seed, n: "9" } });
    expect(await store.releaseClosed({ key: old.key, generation: old.generation })).toBe(false);
    expect(await store.held()).toBe(300_000n);
  });

  it("checks the oldest-checked holds first, so every hold gets a turn", async () => {
    const store = new MemoryUsageStore();
    const addresses = [key(), key(), key()];
    for (const [i, a] of addresses.entries()) await admit(store, await openMatchIx(payer.publicKey, ana, key(), { matchState: a }), { [a.toBase58()]: { ...seed, n: String(i) } });
    const first = (await store.closureCandidates(2)).map((r) => r.key);
    const second = (await store.closureCandidates(2)).map((r) => r.key);
    expect(new Set([...first, ...second]).size).toBe(3);
  });
});

describe("the seed of what an instruction creates", () => {
  it("names the Match of open_match, and the Ticket of open_ticket, from the instruction data", async () => {
    const ana = Keypair.generate().publicKey;
    const match = key(), ticket = key();
    const open = await openMatchIx(payer.publicKey, ana, key(), { matchState: match });
    const tkt = await coreIx("open_ticket", [new BN(7), { entry: {} }, key(), new BN(500), 2], { payer: payer.publicKey, authority: ana, owner: accountOf(ana), ticket, offer: null, sponsor: null });
    const seeds = await holdSeeds([open, tkt], async () => null);
    expect(seeds[match.toBase58()]).toEqual({ kind: "match", account: accountOf(ana).toBase58(), n: "1" });
    expect(seeds[ticket.toBase58()]).toEqual({ kind: "ticket", account: accountOf(ana).toBase58(), n: "7" });
  });

  it("reads the seed of a joined Match from the Match itself", async () => {
    const ana = Keypair.generate().publicKey;
    const join = await joinMatchIx(payer.publicKey, ana, key());
    const match = join.keys[8].pubkey.toBase58();
    const seed: HoldSeed = { kind: "match", account: key().toBase58(), n: "3" };
    expect(await holdSeeds([join], async (m) => (m === match ? seed : null))).toEqual({ [match]: seed });
    expect(await holdSeeds([join], async () => null)).toEqual({});
  });
});

describe("the account slots and argument offsets a seed is read from", () => {
  const ix = (name: string) => (coreIdl.instructions as { name: string; accounts: { name: string }[]; args: { name: string; type: unknown }[] }[]).find((i) => i.name === name)!;
  it("match the deployed IDL", () => {
    expect(ix("open_match").accounts[13].name).toBe("match_state");
    expect(ix("open_match").accounts[7].name).toBe("player_account");
    expect(ix("open_match").args.slice(0, 3).map((a) => a.name)).toEqual(["game", "entry", "n"]);
    expect(ix("open_ticket").accounts[6].name).toBe("ticket");
    expect(ix("open_ticket").accounts[3].name).toBe("owner");
    expect(ix("open_ticket").args[0].name).toBe("nonce");
    expect(ix("join_match").accounts[8].name).toBe("match_state");
    expect(ix("open_ticket").accounts.map((a) => a.name)).toContain("counters");
  });
});

describe("the persistent store (migration 0019)", () => {
  let db: PGlite;
  let sql: ReturnType<typeof completionStore>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role;");
    for (const f of ["0011_sponsor", "0017_sponsor_completion", "0019_sponsor_closure_seeds"]) await db.exec(readFileSync(new URL(`../../../supabase/migrations/${f}.sql`, import.meta.url), "utf8"));
    sql = completionStore(async (fn, args) => {
      const values = Object.values(args);
      return (await db.query<{ value: unknown }>(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(",")}) as value`, values)).rows[0].value;
    });
  });
  afterAll(async () => { await db?.close(); });

  it("keeps a seed with each reservation it acquires, hands them out oldest-checked first, and releases by generation", async () => {
    const ana = Keypair.generate().publicKey;
    const [a, b] = [key(), key()];
    for (const [address, n] of [[a, "0"], [b, "1"]] as const) {
      const ix = await openMatchIx(payer.publicKey, ana, key(), { matchState: address });
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: key().toBase58(), instructions: [new TransactionInstruction({ ...ix, data: Buffer.from(ix.data) })] }).compileToV0Message());
      tx.sign([payer]);
      expect(await sql.prepareCompletion(completionInput(tx, completionEffects([ix]), 300_000n, { [address.toBase58()]: { kind: "match", account: accountOf(ana).toBase58(), n } }))).toBe(true);
    }
    const [first] = await sql.closureCandidates(1);
    const [second] = await sql.closureCandidates(1);
    expect(first.key).not.toBe(second.key);
    expect(first.seed.kind).toBe("match");
    expect(first.seed.account).toBe(accountOf(ana).toBase58());
    expect(await sql.releaseClosed({ key: first.key, generation: "00000000-0000-4000-8000-000000000000" })).toBe(false);
    expect(await sql.releaseClosed({ key: first.key, generation: first.generation })).toBe(true);
    expect(await sql.releaseClosed({ key: first.key, generation: first.generation })).toBe(false);
    const left = await db.query<{ key: string }>("select key from sponsor_hold where key in ($1,$2)", [a.toBase58(), b.toBase58()]);
    expect(left.rows.map((r) => r.key)).toEqual([second.key]);
  });

  it("never offers a hold made without a seed, and refuses a half seed", async () => {
    await db.query("insert into sponsor_hold(key,lamports) values ('legacy',300000)");
    expect((await sql.closureCandidates(50)).map((r) => r.key)).not.toContain("legacy");
    expect(await sql.releaseClosed({ key: "legacy", generation: (await db.query<{ generation: string }>("select generation from sponsor_hold where key='legacy'")).rows[0].generation })).toBe(false);
    await expect(db.query("insert into sponsor_hold(key,lamports,seed_kind) values ('half',1,'match')")).rejects.toThrow();
  });
});
