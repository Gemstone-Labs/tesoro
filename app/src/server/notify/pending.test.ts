import { describe, expect, it, vi } from "vitest";
import fixture from "../history/fixtures/helius-raw-devnet.json";
import { testDb } from "../history/test-db";
import { rpcWebhookStore, type RawTx } from "../history/webhook";
import type { EmailSender } from "./sender";
import { MemoryNotifyStore } from "./store";
import { matchStateOf, type NotifyChain } from "./from-tx";
import { rpcOpenMatchStore } from "./open-match";
import { notifyPending, rpcNotifyTxStore } from "./pending";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const [START_V0] = fixture as unknown as RawTx[];
const A = { account: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ", authority: "authorityOfA" };
const B = { account: "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU", authority: "authorityOfB" };
// The fixture settled at block time 1793243902.
const AFTER = 1_793_243_902 + 3600;
const chain: NotifyChain = { authorityOfAccount: async () => null, request: async () => null, offer: async () => null, position: async () => null };

async function setup(opts: { sender?: EmailSender | "none"; now?: number } = {}) {
  const { rpc, sql } = await testDb();
  const webhook = rpcWebhookStore(rpc);
  const txs = rpcNotifyTxStore(rpc);
  const matches = rpcOpenMatchStore(rpc);
  const store = new MemoryNotifyStore();
  const sent: { to: string; subject: string }[] = [];
  const sender: EmailSender = opts.sender === "none" || !opts.sender ? { send: async (e) => void sent.push(e) } : opts.sender;
  for (const [who, email] of [[A, "a@example.com"], [B, "b@example.com"]] as const) {
    await store.saveEmail(who.authority, email, who.authority);
    await store.verify(who.authority);
  }
  await matches.open({ matchState: matchStateOf(A.account, 3n), matchKey: `${A.account}-3`, game: "block-puzzle", entry: 500, opener: A });
  await matches.join(matchStateOf(A.account, 3n), B, 1_793_243_774 + 3600);
  const notify = opts.sender === "none" ? null : { store, sender, siteUrl: "https://example.test" };
  const run = (over: object = {}) => notifyPending({ txs, matches, chain, notify, now: () => (opts.now ?? AFTER) * 1000, ...over });
  const deliver = (finalized = true) => webhook.put({ signature: START_V0.transaction.signatures[0], slot: START_V0.slot, blockTime: START_V0.blockTime ?? null, body: START_V0, finalized });
  return { rpc, sql, webhook, txs, matches, store, sent, run, deliver, notify };
}

describe("emails from stored transactions", () => {
  it("emails each opted-in Player once about a settled Match, however many times it runs", async () => {
    const t = await setup();
    await t.deliver();
    expect(await t.run()).toMatchObject({ processed: 1, failed: 0 });
    expect(t.sent.map((e) => [e.to, e.subject]).sort()).toEqual([["a@example.com", "You won your Block Burst Match"], ["b@example.com", "You lost your Block Burst Match"]]);
    await t.run();
    await t.sql.query("update public.webhook_tx set notified_at = null, notify_lease_until = null");
    await t.run();
    expect(t.sent).toHaveLength(2);
  });

  it("sends nothing to a Player who has not verified an address", async () => {
    const t = await setup();
    await t.store.saveEmail(B.authority, "new@example.com", "t2");
    await t.deliver();
    await t.run();
    expect(t.sent.map((e) => e.to)).toEqual(["a@example.com"]);
  });

  it("sends nothing to a Player who turned emails off", async () => {
    const t = await setup();
    await t.store.setEnabled(A.authority, false);
    await t.deliver();
    await t.run();
    expect(t.sent.map((e) => e.to)).toEqual(["b@example.com"]);
  });

  it("leaves a transaction that is not finalized alone", async () => {
    const t = await setup();
    await t.deliver(false);
    expect(await t.run()).toMatchObject({ processed: 0 });
    expect(t.sent).toHaveLength(0);
  });

  it("still keeps the open-Match table when email is not set up", async () => {
    const t = await setup({ sender: "none" });
    await t.deliver();
    expect(await t.run()).toMatchObject({ processed: 1 });
    expect(t.sent).toHaveLength(0);
    expect(Number((await t.sql.query<{ n: string }>("select count(*) as n from public.webhook_tx where notified_at is not null")).rows[0].n)).toBe(1);
    expect(Number((await t.sql.query<{ n: string }>("select count(*) as n from public.open_match where closed_at is not null")).rows[0].n)).toBe(1);
  });

  it("does not email about something old", async () => {
    const t = await setup({ now: 1_793_243_902 + 4 * 24 * 3600 });
    await t.deliver();
    expect(await t.run()).toMatchObject({ processed: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it("tries again after a send fails, and gives the same email once", async () => {
    let fail = true;
    const sent: string[] = [];
    const t = await setup({ sender: { send: async (e) => { if (fail && e.to === "b@example.com") throw new Error("down"); sent.push(e.to); } } });
    await t.deliver();
    expect(await t.run()).toMatchObject({ processed: 0, failed: 1 });
    fail = false;
    expect(await t.run()).toMatchObject({ processed: 1, failed: 0 });
    expect(sent.sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("gives up on a transaction after five failures and goes on to the next", async () => {
    const t = await setup({ sender: { send: async () => { throw new Error("down"); } } });
    await t.deliver();
    for (let i = 0; i < 5; i++) await t.run();
    expect((await t.sql.query<{ notify_error: string }>("select notify_error from public.webhook_tx")).rows[0].notify_error).toBe("down");
    expect(await t.run()).toMatchObject({ processed: 0, failed: 0 });
  });

  it("holds a claimed transaction so a second worker does not take it", async () => {
    const t = await setup();
    await t.deliver();
    expect(await t.txs.claim(10, 120)).toHaveLength(1);
    expect(await t.txs.claim(10, 120)).toHaveLength(0);
  });
});

