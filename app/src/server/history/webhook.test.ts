import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/helius-raw-devnet.json";
import { catchUp, decodePending, receiveWebhook, recordsOfRawTx, rpcWebhookStore, WebhookHttpError, type CoreChain, type RawTx, type ReceiveDeps } from "./webhook";
import { testDb } from "./test-db";

// A fresh in-process Postgres takes several seconds to start when the machine is busy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Real tesoro_core transactions from devnet (getTransaction, json encoding; signatures renamed, they look like secret keys to the
// commit hook: start 27GUT7ye, settle 5SBDy9dT, legacy start rcRU4CKb), in the Helius raw webhook shape (indexWithinBlock is assumed).
const [START_V0, SETTLE_V0, START_LEGACY] = fixture as unknown as RawTx[];
const sig = (t: RawTx) => t.transaction.signatures[0];
const SECRET = "s3cret";

async function setup(over: Partial<ReceiveDeps> = {}) {
  const { rpc, sql } = await testDb();
  const store = rpcWebhookStore(rpc);
  const scheduled: (() => Promise<unknown>)[] = [];
  const ingests = vi.fn(rpc);
  const deps: ReceiveDeps = { store, secret: SECRET, schedule: (w) => void scheduled.push(w), afterStore: () => decodePending({ store, rpc: ingests }), ...over };
  const count = async (table: string) => Number((await sql.query<{ n: string }>(`select count(*) as n from public.${table}`)).rows[0].n);
  return { rpc, sql, store, deps, scheduled, ingests, count };
}

describe("decoding a delivered transaction", () => {
  it("finds the Match records in the real devnet transactions", () => {
    expect(recordsOfRawTx(START_V0).map((r) => r.type)).toEqual(["won", "start", "lines-start"]);
    expect(recordsOfRawTx(SETTLE_V0).map((r) => r.type)).toEqual(["chunk", "line-step", "lines-progress", "settled"]);
    expect(recordsOfRawTx(START_LEGACY).map((r) => r.type)).toEqual(["won", "start", "lines-start"]);
  });

  it("finds nothing in a failed transaction", () => {
    expect(recordsOfRawTx({ ...START_V0, meta: { ...START_V0.meta!, err: { InstructionError: [0, "Custom"] } } })).toEqual([]);
  });
});

describe("the webhook route", () => {
  it("refuses a wrong secret and stores nothing", async () => {
    const t = await setup();
    await expect(receiveWebhook(t.deps, "Bearer nope", [START_V0])).rejects.toMatchObject({ status: 401 });
    await expect(receiveWebhook(t.deps, null, [START_V0])).rejects.toMatchObject({ status: 401 });
    expect(await t.count("webhook_tx")).toBe(0);
    expect(t.scheduled).toHaveLength(0);
  });

  it("is not configured without a secret", async () => {
    const t = await setup({ secret: undefined });
    await expect(receiveWebhook(t.deps, SECRET, [START_V0])).rejects.toBeInstanceOf(WebhookHttpError);
  });

  it("accepts the secret with or without Bearer", async () => {
    const t = await setup();
    expect((await receiveWebhook(t.deps, SECRET, [START_V0])).stored).toBe(1);
    expect((await receiveWebhook(t.deps, `Bearer ${SECRET}`, [SETTLE_V0])).stored).toBe(1);
  });

  it("stores a duplicate delivery once", async () => {
    const t = await setup();
    expect(await receiveWebhook(t.deps, SECRET, [START_V0, SETTLE_V0])).toEqual({ stored: 2, duplicates: 0, ignored: 0 });
    expect(await receiveWebhook(t.deps, SECRET, [START_V0])).toEqual({ stored: 0, duplicates: 1, ignored: 0 });
    expect(await t.count("webhook_tx")).toBe(2);
  });

  it("ignores failed transactions and malformed items", async () => {
    const t = await setup();
    const failed = { ...START_V0, meta: { ...START_V0.meta!, err: { InstructionError: [0, "Custom"] } } };
    expect(await receiveWebhook(t.deps, SECRET, [failed, { nonsense: true }, START_V0])).toEqual({ stored: 1, duplicates: 0, ignored: 2 });
    await expect(receiveWebhook(t.deps, SECRET, "text")).rejects.toMatchObject({ status: 400 });
  });

  it("answers before it decodes", async () => {
    const t = await setup({ deliveredFinalized: true });
    await receiveWebhook(t.deps, SECRET, [START_V0]);
    expect(t.ingests).not.toHaveBeenCalled();
    expect(await t.count("match_history")).toBe(0);
    expect(t.scheduled).toHaveLength(1);
    await t.scheduled[0]();
    expect(await t.count("match_history")).toBe(1);
  });

  it("decodes only finalized rows: a confirmed delivery waits for the catch-up", async () => {
    const t = await setup();
    await receiveWebhook(t.deps, SECRET, [START_V0]);
    await t.scheduled[0]();
    expect(await t.count("match_history")).toBe(0);
    await t.store.markFinalized([sig(START_V0)]);
    expect(await decodePending({ store: t.store, rpc: t.rpc })).toEqual({ decoded: 1, failed: 0 });
    expect(await t.count("match_history")).toBe(1);
    expect(await decodePending({ store: t.store, rpc: t.rpc })).toEqual({ decoded: 0, failed: 0 });
  });

  it("decodes a Match end to end and repeats harmlessly", async () => {
    const t = await setup({ deliveredFinalized: true });
    await receiveWebhook(t.deps, SECRET, [START_V0, SETTLE_V0]);
    await t.scheduled[0]();
    const rows = await t.count("match_history");
    await t.sql.query("update public.webhook_tx set decoded_at = null");
    await decodePending({ store: t.store, rpc: t.rpc });
    expect(await t.count("match_history")).toBe(rows);
  });

  it("marks an undecodable transaction and goes on to the next", async () => {
    const t = await setup({ deliveredFinalized: true });
    const broken: RawTx = JSON.parse(JSON.stringify(START_LEGACY));
    broken.slot = 1;
    broken.transaction.signatures = ["broken"];
    broken.meta!.innerInstructions![0].instructions[0].programIdIndex = 999;
    await receiveWebhook(t.deps, SECRET, [broken, START_V0]);
    expect(await decodePending({ store: t.store, rpc: t.rpc })).toEqual({ decoded: 1, failed: 1 });
    expect((await t.sql.query<{ decode_error: string }>("select decode_error from public.webhook_tx where signature = 'broken'")).rows[0].decode_error).toMatch(/999/);
    expect(await decodePending({ store: t.store, rpc: t.rpc })).toEqual({ decoded: 0, failed: 0 });
  });
});

describe("the catch-up scan", () => {
  const raw = (s: string, slot: number): RawTx => ({ ...START_V0, slot, transaction: { ...START_V0.transaction, signatures: [s] } });
  function chain(history: string[], unreadable: string[] = []) {
    const asked: { until?: string; before?: string }[] = [];
    const c: CoreChain = {
      signatures: async ({ until, before, limit }) => {
        asked.push({ until, before });
        const newestFirst = [...history].reverse();
        const from = before ? newestFirst.indexOf(before) + 1 : 0;
        const stop = until ? newestFirst.indexOf(until) : newestFirst.length;
        return newestFirst.slice(from, stop < 0 ? newestFirst.length : stop).slice(0, limit);
      },
      transaction: async (s) => (unreadable.includes(s) ? null : raw(s, history.indexOf(s) + 100)),
      finalized: async (ss) => ss,
    };
    return { c, asked };
  }

  it("stores what the webhook missed and resumes from the last signature", async () => {
    const t = await setup();
    const { c, asked } = chain(["a", "b", "c"]);
    expect(await catchUp({ store: t.store, chain: c })).toMatchObject({ stored: 3, cursor: "c" });
    expect(await t.store.cursor()).toBe("c");
    const later = chain(["a", "b", "c", "d", "e"]);
    expect(await catchUp({ store: t.store, chain: later.c })).toMatchObject({ stored: 2, cursor: "e" });
    expect(later.asked[0].until).toBe("c");
    expect(asked[0].until).toBeUndefined();
    expect(await t.count("webhook_tx")).toBe(5);
  });

  it("fills a gap behind a delivered transaction", async () => {
    const t = await setup();
    await t.store.put({ signature: "c", slot: 102, blockTime: null, body: raw("c", 102), finalized: false });
    const { c } = chain(["a", "b", "c"]);
    expect(await catchUp({ store: t.store, chain: c })).toMatchObject({ stored: 2 });
    expect(await t.count("webhook_tx")).toBe(3);
  });

  it("stops the cursor before a transaction it cannot read", async () => {
    const t = await setup();
    const { c } = chain(["a", "b", "c"], ["b"]);
    expect(await catchUp({ store: t.store, chain: c })).toMatchObject({ stored: 1, cursor: "a" });
    expect(await t.store.cursor()).toBe("a");
  });

  it("marks a delivered row finalized once the chain finalizes it", async () => {
    const t = await setup();
    await receiveWebhook(t.deps, SECRET, [START_V0]);
    const { c } = chain([]);
    expect(await catchUp({ store: t.store, chain: c })).toMatchObject({ finalized: 1 });
    expect((await t.store.toDecode(10)).map((r) => r.signature)).toEqual([sig(START_V0)]);
  });
});
