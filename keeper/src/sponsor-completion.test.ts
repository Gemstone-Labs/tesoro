import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { MemoryUsageStore } from "../../app/src/server/sponsor/store.ts";
import { completionEffects, recoverCompletions, type CompletionStore } from "../../app/src/server/sponsor/completion.ts";
import { closeMatchIx, closeTicketIx } from "./core-ix.ts";
import { loadIdl } from "./runtime.ts";
import { sendIxs } from "./send.ts";
import { keeperCompletionStore } from "./sponsor-completion.ts";

const payer = Keypair.generate();
const k = () => Keypair.generate().publicKey;
const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(payer), {}));

function chain(store: CompletionStore, timeout = false) {
  let sent = 0;
  let proof: VersionedTransactionResponse | null = null;
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: k().toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      const [journal] = await store.pendingCompletions();
      assert.ok(journal, "The exact signed transaction must be durable before broadcast");
      assert.equal(journal.raw, Buffer.from(raw).toString("base64"));
      sent++;
      const tx = VersionedTransaction.deserialize(raw);
      proof = { transaction: { message: tx.message, signatures: [journal.signature] }, meta: {
        err: null, fee: 5000, preBalances: tx.message.staticAccountKeys.map(() => 10_363_200), postBalances: tx.message.staticAccountKeys.map(() => 0),
      }, slot: 10, version: 0 };
      if (timeout) throw new Error("broadcast timed out after landing");
      return journal.signature;
    },
    getSignatureStatuses: async () => ({ context: { slot: 10 }, value: [{ err: null, confirmationStatus: "confirmed" }] }),
    getTransaction: async (_sig: string, opts: { commitment: string }) => { assert.equal(opts.commitment, "finalized"); return proof; },
  };
  return { conn: conn as unknown as Connection, sent: () => sent };
}

describe("keeper physical close accounting", () => {
  it("accepts an empty successful REST response after recording a completion", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(null, { status: 204 });
      const store = keeperCompletionStore({ SUPABASE_URL: "https://test.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture" })!;
      await assert.doesNotReject(store.finishCompletion("known-close", true));
    } finally { globalThis.fetch = original; }
  });
  it("journals close_match and releases its Match and both consumed Entry Tickets", async () => {
    const store = new MemoryUsageStore();
    const matchState = k(), potA = k(), potB = k();
    const ix = await closeMatchIx(core, { caller: payer.publicKey, matchState, matchPayer: payer.publicKey, potA, potAPayer: payer.publicKey, potB, potBPayer: payer.publicKey, sponsor: null, remaining: [] });
    for (const key of [matchState, potA, potB]) await store.hold(key.toBase58(), 300_000n);
    await store.hold("unrelated", 900n);
    const c = chain(store);
    await sendIxs(c.conn, payer, [ix], { completion: store });
    assert.equal(c.sent(), 1);
    assert.equal(await store.held(), 900n);
    assert.deepEqual(completionEffects([ix]).closes, [matchState, potA, potB].map((x) => x.toBase58()));
  });

  it("keeps an uncertain close_ticket reserve and recovers without the Ticket inventory", async () => {
    const store = new MemoryUsageStore(), ticket = k();
    await store.hold(ticket.toBase58(), 300_000n);
    const ix = await closeTicketIx(core, { caller: payer.publicKey, ticket, payer: payer.publicKey, sponsor: null });
    const c = chain(store, true);
    await assert.rejects(sendIxs(c.conn, payer, [ix], { completion: store }), /timed out/);
    assert.equal(await store.held(), 300_000n);
    assert.equal(await recoverCompletions(store, c.conn), 1);
    assert.equal(await store.held(), 0n);
    await store.hold(ticket.toBase58(), 300_000n);
    assert.equal(await recoverCompletions(store, c.conn), 0);
    assert.equal(await store.held(), 300_000n, "old proof cannot release a reused Ticket");
  });

  it("broadcasts nothing when the durable prepare fails", async () => {
    const store = new MemoryUsageStore();
    store.prepareCompletion = async () => { throw new Error("database unavailable"); };
    const c = chain(store);
    const ix = await closeTicketIx(core, { caller: payer.publicKey, ticket: k(), payer: payer.publicKey, sponsor: null });
    await assert.rejects(sendIxs(c.conn, payer, [ix], { completion: store }), /database unavailable/);
    assert.equal(c.sent(), 0);
  });
});
