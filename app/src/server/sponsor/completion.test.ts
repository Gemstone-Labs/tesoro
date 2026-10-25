import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completionEffects, completionInput, completionStore, recoverCompletions, type CompletionChain, type CompletionStore } from "./completion";
import { coreIx, key } from "./fixtures";
import { MemoryUsageStore } from "./store";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const payer = Keypair.generate();
const capturedMatch = new PublicKey("ACcQQF3FK7ujjKa8qeu1zRv8gR3U1JSVAAC9qttbdueZ");
const core = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

async function transaction(kind: "close_match" | "close_ticket" = "close_match", address = capturedMatch, pots = [key(), key()]) {
  const ix = kind === "close_match"
    ? await coreIx(kind, [], { caller: payer.publicKey, matchState: address, matchPayer: payer.publicKey, potA: pots[0], potAPayer: payer.publicKey, potB: pots[1], potBPayer: payer.publicKey, sponsor: null })
    : await coreIx(kind, [], { caller: payer.publicKey, ticket: address, payer: payer.publicKey, sponsor: null });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: key().toBase58(), instructions: [new TransactionInstruction({ ...ix, data: Buffer.from(ix.data) })] }).compileToV0Message());
  tx.sign([payer]);
  const input = completionInput(tx, completionEffects([ix]), 0n);
  const proof: VersionedTransactionResponse = { transaction: { message: tx.message, signatures: [input.signature] }, meta: {
    err: null, fee: 5000, preBalances: tx.message.staticAccountKeys.map(() => 10_363_200), postBalances: tx.message.staticAccountKeys.map(() => 0),
  }, slot: 100, version: 0 };
  return { input, proof, chain: { getTransaction: async () => proof } satisfies CompletionChain };
}

let db: PGlite;
let sql: CompletionStore;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(readFileSync(new URL("../../../supabase/migrations/0011_sponsor.sql", import.meta.url), "utf8"));
  // This existing reservation represents B14's captured hold; the SQL must preserve it while adding generations.
  await db.query("insert into sponsor_hold(key,lamports) values ($1,300000)", [capturedMatch.toBase58()]);
  await db.exec(readFileSync(new URL("../../../supabase/migrations/0017_sponsor_completion.sql", import.meta.url), "utf8"));
  sql = completionStore(async (fn, args) => {
    const values = Object.values(args);
    const result = await db.query<{ value: unknown }>(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(",")}) as value`, values);
    return result.rows[0].value;
  });
});
afterAll(async () => { await db?.close(); });
const heldSql = async () => BigInt((await db.query<{ total: string }>("select coalesce(sum(lamports),0)::text as total from sponsor_hold")).rows[0].total);

describe("persistent sponsor completion", () => {
  it("repairs the captured 300,000-lamport hold after a physical close, preserving unrelated reserves", async () => {
    await db.query("insert into sponsor_hold(key,lamports) values ('unrelated',900)");
    expect(await heldSql()).toBe(300_900n);
    const t = await transaction();
    await sql.prepareCompletion(t.input);
    // The sender died after confirmation: a new adapter recovers using only the persisted transaction.
    expect(await recoverCompletions(sql, t.chain)).toBe(1);
    expect(await heldSql()).toBe(900n);
    expect(await recoverCompletions(sql, t.chain)).toBe(0);
  });

  it("retains failed/uncertain close holds; settlement or account absence is insufficient", async () => {
    const address = key();
    await db.query("insert into sponsor_hold(key,lamports) values ($1,300000)", [address.toBase58()]);
    const t = await transaction("close_ticket", address);
    await sql.prepareCompletion(t.input);
    const before = await heldSql();
    expect(await recoverCompletions(sql, { getTransaction: async (_sig, opts) => { expect(opts.commitment).toBe("finalized"); return null; } })).toBe(0);
    expect(await heldSql()).toBe(before);
    t.proof.meta!.postBalances = t.proof.meta!.preBalances;
    expect(await recoverCompletions(sql, t.chain)).toBe(0);
    expect(await heldSql()).toBe(before);
    t.proof.meta!.err = { InstructionError: [0, "InvalidArgument"] };
    expect(await recoverCompletions(sql, t.chain)).toBe(1);
    expect(await heldSql()).toBe(before);
  });

  it("releases consumed Tickets with their Match and never applies old proof to a reused address", async () => {
    const address = key(), pots = [key(), key()];
    for (const p of [address, ...pots]) await db.query("insert into sponsor_hold(key,lamports) values ($1,300000)", [p.toBase58()]);
    const t = await transaction("close_match", address, pots);
    await sql.prepareCompletion(t.input);
    const reuse = { ...t.input, signature: "new-admission", creates: [pots[0].toBase58()], ensures: [], closes: [], reserve: "300000" };
    await expect(sql.prepareCompletion(reuse)).rejects.toThrow("Reservation already exists");
    const before = await heldSql();
    await recoverCompletions(sql, t.chain);
    expect(await heldSql()).toBe(before - 900_000n);
    await sql.prepareCompletion(reuse);
    const newBalance = await heldSql();
    expect(await sql.prepareCompletion(t.input)).toBe(false);
    await sql.finishCompletion(t.input.signature, true);
    expect(await heldSql()).toBe(newBalance);
    await sql.finishCompletion(reuse.signature, false);
  });

  it("fences concurrent admissions and pending closes and gives back only a failed transaction's own holds", async () => {
    const ticket = key().toBase58();
    const make = (signature: string) => ({ signature, raw: signature, creates: [ticket], ensures: [], closes: [], reserve: "300000" });
    const a = make("pending-admission");
    const results = await Promise.allSettled([sql.prepareCompletion(a), sql.prepareCompletion(make("competitor"))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    await expect(sql.prepareCompletion({ ...make("join-pending"), creates: [], ensures: [ticket] })).rejects.toThrow("unresolved");
    const before = await heldSql();
    await sql.finishCompletion(a.signature, false);
    expect(await heldSql()).toBe(before - 300_000n);
    await expect(sql.prepareCompletion(a)).rejects.toThrow("failed");
    const live = make("live-ticket");
    await sql.prepareCompletion(live);
    await sql.finishCompletion(live.signature, true);
    const close = { ...make("pending-close"), creates: [], closes: [ticket] };
    await sql.prepareCompletion(close);
    await expect(sql.prepareCompletion({ ...make("join-closing"), creates: [], ensures: [ticket] })).rejects.toThrow("unresolved");
    await sql.finishCompletion(close.signature, false);
    const ensure = { ...make("join-live"), creates: [], ensures: [ticket] };
    await sql.prepareCompletion(ensure);
    await sql.finishCompletion(ensure.signature, false);
    expect(await heldSql()).toBe(before);
  });

  it("does not trust one preflight rejection after another worker can broadcast the saved admission", async () => {
    const ticket = key().toBase58();
    const input = { signature: "preflight-recovery-race", raw: "saved-signed-admission", creates: [ticket], ensures: [], closes: [], reserve: "300000" };
    await sql.prepareCompletion(input);
    const before = await heldSql();
    await sql.pendingCompletions(); // atomically claims the right to rebroadcast
    await sql.finishCompletion(input.signature, false, true);
    expect(await heldSql()).toBe(before);
    expect((await sql.pendingCompletions()).some((j) => j.signature === input.signature)).toBe(true);
    await sql.finishCompletion(input.signature, false); // finalized chain failure
    expect(await heldSql()).toBe(before - 300_000n);

    const originalOnly = { ...input, signature: "preflight-original-only" };
    await sql.prepareCompletion(originalOnly);
    await sql.finishCompletion(originalOnly.signature, false, true);
    expect(await heldSql()).toBe(before - 300_000n);
    await expect(sql.prepareCompletion(originalOnly)).rejects.toThrow("failed");
  });

  it("retains durable work when the process dies before or after confirmation", async () => {
    const address = key();
    const t = await transaction("close_ticket", address);
    await db.query("insert into sponsor_hold(key,lamports) values ($1,300000)", [address.toBase58()]);
    await sql.prepareCompletion(t.input);
    const before = await heldSql();
    const crash: CompletionStore = { ...sql, finishCompletion: async () => { throw new Error("database unavailable after confirmation"); } };
    await expect(recoverCompletions(crash, t.chain)).rejects.toThrow("database unavailable");
    expect(await heldSql()).toBe(before);
    expect(await recoverCompletions(sql, t.chain)).toBeGreaterThanOrEqual(1);
    expect(await heldSql()).toBe(before - 300_000n);
  });

  it("blocks anonymous RPC calls and legacy address-only deletes, including service-role deletes", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set role ${role}`);
      await expect(db.exec("delete from sponsor_hold where key='unrelated'")).rejects.toThrow();
      if (role !== "service_role") await expect(sql.pendingCompletions()).rejects.toThrow();
      else await expect(sql.pendingCompletions()).resolves.toBeInstanceOf(Array);
      await db.exec("reset role");
    }
  });
});

describe("closure evidence", () => {
  it("resolves a consumed Ticket through a v0 lookup table before checking its rent return", async () => {
    const ticket = key();
    const ix = await coreIx("close_ticket", [], { caller: payer.publicKey, ticket, payer: payer.publicKey, sponsor: null });
    const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 0xffff_ffff_ffff_ffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [ticket] } });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: key().toBase58(), instructions: [new TransactionInstruction({ ...ix, data: Buffer.from(ix.data) })] }).compileToV0Message([table]));
    tx.sign([payer]);
    const input = completionInput(tx, completionEffects([ix]), 0n);
    const store = new MemoryUsageStore();
    await store.hold(ticket.toBase58(), 300_000n);
    await store.prepareCompletion(input);
    const count = tx.message.staticAccountKeys.length + 1;
    const proof: VersionedTransactionResponse = { transaction: { message: tx.message, signatures: [input.signature] }, meta: {
      err: null, fee: 5000, preBalances: Array(count).fill(1), postBalances: Array(count).fill(0), loadedAddresses: { writable: [ticket], readonly: [] },
    }, slot: 1, version: 0 };
    expect(tx.message.addressTableLookups).toHaveLength(1);
    expect(await recoverCompletions(store, { getTransaction: async () => proof })).toBe(1);
    expect(await store.held()).toBe(0n);
  });
  it("recovers a crash before broadcast by retrying the exact saved signature while its blockhash is valid", async () => {
    const t = await transaction("close_ticket", key());
    const store = new MemoryUsageStore();
    await store.hold(t.input.closes[0], 300_000n);
    await store.prepareCompletion(t.input);
    const sendRawTransaction = vi.fn(async () => t.input.signature);
    const chain = { getTransaction: async () => null, isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }), sendRawTransaction };
    expect(await recoverCompletions(store, chain)).toBe(0);
    expect(sendRawTransaction).toHaveBeenCalledWith(Buffer.from(t.input.raw, "base64"), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
    expect(await store.held()).toBe(300_000n);
    expect(await recoverCompletions(store, t.chain)).toBe(1);
    expect(await store.held()).toBe(0n);
  });
  it("does not release a different account that happens to reach zero", async () => {
    const t = await transaction("close_ticket", key());
    const store = new MemoryUsageStore();
    await store.hold(payer.publicKey.toBase58(), 300_000n);
    await store.prepareCompletion({ ...t.input, closes: [payer.publicKey.toBase58()] });
    expect(await recoverCompletions(store, t.chain)).toBe(0);
    expect(await store.held()).toBe(300_000n);
  });

  it("the close targets use the deployed IDL's exact account roles", () => {
    const roles = { close_match: ["match_state", "pot_a", "pot_b"], close_ticket: ["ticket"] };
    for (const [name, expected] of Object.entries(roles)) {
      const ix = coreIdl.instructions.find((i) => i.name === name)!;
      const keys = ix.accounts.map(() => ({ pubkey: key(), isSigner: false, isWritable: true }));
      const got = completionEffects([{ programId: core, data: Buffer.from(ix.discriminator), keys }]);
      expect(got.closes).toEqual(expected.map((n) => keys[ix.accounts.findIndex((a) => a.name === n)].pubkey.toBase58()));
    }
  });
});
