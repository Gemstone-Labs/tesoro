import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restRpc } from "./history.ts";

const reply = (status: number, body: string) => (async () => new Response(body || null, { status })) as unknown as typeof fetch;

describe("the REST rpc to the database", () => {
  it("returns the JSON a function answers with", async () => {
    assert.deepEqual(await restRpc("https://db", "key", reply(200, '{"ok":true}'))("some_fn", {}), { ok: true });
  });

  // Postgres functions that return void (publish_table_pool) answer 204 with no body: that is success.
  it("returns null for an empty answer instead of failing to parse it", async () => {
    assert.equal(await restRpc("https://db", "key", reply(204, ""))("publish_table_pool", {}), null);
  });

  it("throws on a non-2xx answer", async () => {
    await assert.rejects(restRpc("https://db", "key", reply(400, "bad"))("some_fn", {}), /failed: 400 bad/);
  });
});
