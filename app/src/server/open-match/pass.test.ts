import { describe, expect, it, vi } from "vitest";
import fixture from "../history/fixtures/helius-raw-devnet.json";
import { testDb } from "../history/test-db";
import { rpcWebhookStore, type RawTx } from "../history/webhook";
import { pruneOpenMatches, rpcTrackTxStore, trackPending } from "./pass";
import { rpcOpenMatchStore } from "./store";
import { matchStateOf } from "./track";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const [START_V0] = fixture as unknown as RawTx[];
const A = { account: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ", authority: "authorityOfA" };
const B = { account: "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU", authority: "authorityOfB" };

async function setup() {
  const { rpc, sql } = await testDb();
  const webhook = rpcWebhookStore(rpc);
  const txs = rpcTrackTxStore(rpc);
  const matches = rpcOpenMatchStore(rpc);
  await matches.open({ matchState: matchStateOf(A.account, 3n), matchKey: `${A.account}-3`, game: "block-puzzle", entry: 500, opener: A });
  await matches.join(matchStateOf(A.account, 3n), B, 1_793_243_774 + 3600);
  const run = () => trackPending({ txs, matches, warn: () => {} });
  const deliver = (finalized = true) => webhook.put({ signature: START_V0.transaction.signatures[0], slot: START_V0.slot, blockTime: START_V0.blockTime ?? null, body: START_V0, finalized });
  const closed = async () => Number((await sql.query<{ n: string }>("select count(*) as n from public.open_match where closed_at is not null")).rows[0].n);
  return { sql, txs, matches, run, deliver, closed };
}

describe("open-Match tracking from stored transactions", () => {
  it("closes the settled Match and marks the transaction done, however many times it runs", async () => {
    const t = await setup();
    await t.deliver();
    expect(await t.run()).toMatchObject({ processed: 1, failed: 0 });
    expect(await t.closed()).toBe(1);
    expect(await t.run()).toMatchObject({ processed: 0 });
    await t.sql.query("update public.webhook_tx set notified_at = null, notify_lease_until = null");
    expect(await t.run()).toMatchObject({ processed: 1, failed: 0 });
    expect(await t.closed()).toBe(1);
  });

  it("leaves a transaction that is not finalized alone", async () => {
    const t = await setup();
    await t.deliver(false);
    expect(await t.run()).toMatchObject({ processed: 0 });
    expect(await t.closed()).toBe(0);
  });

  it("gives up on a transaction after five failures and goes on to the next", async () => {
    const t = await setup();
    await t.deliver();
    vi.spyOn(t.matches, "close").mockRejectedValue(new Error("db down"));
    for (let i = 0; i < 5; i++) await t.run();
    expect((await t.sql.query<{ notify_error: string }>("select notify_error from public.webhook_tx")).rows[0].notify_error).toBe("db down");
    expect(await t.run()).toMatchObject({ processed: 0, failed: 0 });
  });

  it("holds a claimed transaction so a second worker does not take it", async () => {
    const t = await setup();
    await t.deliver();
    expect(await t.txs.claim(10, 120)).toHaveLength(1);
    expect(await t.txs.claim(10, 120)).toHaveLength(0);
  });

  it("prunes through the store", async () => {
    const t = await setup();
    expect(await pruneOpenMatches(t.matches, 1_000_000_000)).toBeTypeOf("number");
  });
});
