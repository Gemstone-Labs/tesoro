import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLUSTERS } from "../../app/src/lib/cluster-settings.ts";
import { fetchSolUsd, priceJob, priceJobEnabled } from "./price.ts";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

/** Stubs the three public sources; `null` makes one fail. */
function quotes(q: { pyth?: number | null; pythAge?: number; pythConf?: number; gecko?: number | null; coinbase?: number | null }) {
  globalThis.fetch = (async (url: string) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("pyth") && q.pyth != null) {
      const publish_time = Math.floor(Date.now() / 1000) - (q.pythAge ?? 5);
      return ok({ parsed: [{ price: { price: String(Math.round(q.pyth * 1e8)), expo: -8, conf: String(Math.round((q.pythConf ?? 0.1) * 1e8)), publish_time } }] });
    }
    if (url.includes("coingecko") && q.gecko != null) return ok({ solana: { usd: q.gecko } });
    if (url.includes("coinbase") && q.coinbase != null) return ok({ data: { amount: String(q.coinbase) } });
    return new Response("down", { status: 503 });
  }) as typeof fetch;
}

describe("fetchSolUsd (OC-01)", () => {
  it("uses the median of the sources that answer", async () => {
    quotes({ pyth: 150, gecko: 152, coinbase: 400 });
    assert.equal((await fetchSolUsd(150)).usd, 152);
    quotes({ pyth: null, gecko: 150, coinbase: 154 });
    assert.equal((await fetchSolUsd(null)).usd, 152);
  });

  it("throws on a full outage instead of returning an old price", async () => {
    quotes({ pyth: null, gecko: null, coinbase: null });
    await assert.rejects(fetchSolUsd(150));
  });

  it("accepts a lone source only near the last price", async () => {
    quotes({ coinbase: 160 });
    assert.equal((await fetchSolUsd(150)).usd, 160);
    quotes({ coinbase: 60 });
    await assert.rejects(fetchSolUsd(150), /alone moves/);
  });

  it("drops a stale or wide Pyth update", async () => {
    quotes({ pyth: 150, pythAge: 600 });
    await assert.rejects(fetchSolUsd(150), /stale/);
    quotes({ pyth: 150, pythConf: 10 });
    await assert.rejects(fetchSolUsd(150), /confidence/);
  });
});

describe("priceJob is a test-mode job (ADR 0011)", () => {
  it("runs only where the keeper writes the Advance price", () => {
    assert.equal(priceJobEnabled(CLUSTERS.test), true);
    assert.equal(priceJobEnabled(CLUSTERS.mainnet), false);
  });

  it("does nothing on mainnet: no RPC read, no price source asked, no transaction", async () => {
    globalThis.fetch = (async () => {
      throw new Error("a mainnet pass must not ask a price source");
    }) as typeof fetch;
    const ctx = new Proxy({}, { get: () => { throw new Error("a mainnet pass must not touch the chain"); } }) as never;
    assert.equal(await priceJob(ctx, CLUSTERS.mainnet), 0);
  });
});
