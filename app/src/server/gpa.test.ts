import { Keypair } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import coreIdl from "../lib/chain/idl/tesoro_core.json";
import { OVERFLOW_DISC, OVERFLOW_OWNER_AT } from "../lib/chain/overflow";
import { GpaInputError, GpaUpstreamError, createListCache, parseQuery } from "./gpa";

const CORE = coreIdl.address;
const disc = (name: string) => utils.bytes.bs58.encode(Uint8Array.from(coreIdl.accounts.find((a) => a.name === name)!.discriminator));
const MATCH = disc("MatchState");
const HOLDING = disc("TesoroAccount");
const POSITION = disc("PositionState");
const q = (s: string) => parseQuery(new URLSearchParams(s));

/** A TesoroAccount-shaped row whose owner key sits at offset 9. */
function row(owner: Uint8Array, i: number) {
  const data = Buffer.alloc(80);
  Buffer.from(owner).copy(data, 9);
  return { pubkey: `row${i}`, account: { data: [data.toString("base64"), "base64"] as [string, string] } };
}

/** Stub upstream: each call answers with `next()` (a status or rows) and is counted. */
function upstream(next: () => number | unknown[]) {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    const r = next();
    if (typeof r === "number") return new Response("{}", { status: r });
    return Response.json({ jsonrpc: "2.0", id: 1, result: r });
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

describe("gpa parseQuery", () => {
  it("accepts exactly the shapes the app sends", () => {
    expect(q(`program=${CORE}&filter=m:0:${MATCH}`)).toMatchObject({ disc: MATCH, owner: null });
    const owner = Keypair.generate().publicKey.toBase58();
    expect(q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${owner}`).owner?.key.toBase58()).toBe(owner);
    expect(q(`program=${CORE}&filter=m:0:${POSITION}&filter=m:41:${owner}`).owner?.offset).toBe(41);
    // overflow records are not in the IDL; the owner Account's key sits in the store header
    const records = utils.bytes.bs58.encode(OVERFLOW_DISC);
    expect(q(`program=${CORE}&filter=m:0:${records}&filter=m:${OVERFLOW_OWNER_AT}:${owner}`).owner?.offset).toBe(OVERFLOW_OWNER_AT);
    expect(() => q(`program=${CORE}&filter=m:0:${records}&filter=m:41:${owner}`)).toThrow(GpaInputError);
  });

  it("rejects everything else", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const bad = [
      "program=11111111111111111111111111111111",
      `program=${CORE}`,
      `program=${CORE}&filter=m:0:${disc("Config")}`,
      `program=${CORE}&filter=m:0:${MATCH}&slice=0:8`,
      `program=${CORE}&filter=m:0:${MATCH}&filter=s:120`,
      `program=${CORE}&filter=m:0:${MATCH}&filter=m:9:${owner}`,
      `program=${CORE}&filter=m:0:${HOLDING}&filter=m:41:${owner}`,
      `program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:2222`,
      `program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${owner}&filter=m:9:${owner}`,
      `program=${CORE}&program=${CORE}&filter=m:0:${MATCH}`,
    ];
    for (const s of bad) expect(() => q(s), s).toThrow(GpaInputError);
  });
});

describe("gpa list cache (OC-03)", () => {
  // The offline repro (docs/reviews/2026-09-30-evidence/oc-gpa-amplification.log): 50 distinct slices
  // made 50 upstream calls, and after one 429 a never-cached legitimate query was refused.
  it("50 distinct queries make no upstream calls; distinct owners share one", async () => {
    const up = upstream(() => []);
    const lists = createListCache({ fetch: up.fetch });
    for (let i = 0; i < 50; i++) expect(() => q(`program=${CORE}&filter=m:0:${MATCH}&slice=${i}:8`)).toThrow(GpaInputError);
    for (let i = 0; i < 50; i++) await lists.getAccounts(q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${Keypair.generate().publicKey.toBase58()}`));
    expect(up.calls()).toBe(1);
  });

  it("after an upstream 429, a never-asked owner query is served from the cached list", async () => {
    const mine = Keypair.generate().publicKey;
    let t = 0;
    let status = 0;
    const up = upstream(() => (status ? status : [row(mine.toBytes(), 1), row(Keypair.generate().publicKey.toBytes(), 2)]));
    const lists = createListCache({ fetch: up.fetch, now: () => t });
    await lists.getAccounts(q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${Keypair.generate().publicKey.toBase58()}`));
    status = 429;
    t = 200_000; // past the 2 min stale window: the next read refreshes and gets the 429
    const got = await lists.getAccounts(q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${mine.toBase58()}`));
    expect(got.map((r) => r.pubkey)).toEqual(["row1"]);
    // Still inside the backoff: stale rows, no further upstream call.
    t += 1_000;
    expect(await lists.getAccounts(q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${mine.toBase58()}`))).toHaveLength(1);
    expect(up.calls()).toBe(2);
  });

  it("serves stale rows on any upstream failure and errors only without a cache", async () => {
    let t = 0;
    let status = 0;
    const up = upstream(() => (status ? status : [row(new Uint8Array(32), 1)]));
    const lists = createListCache({ fetch: up.fetch, now: () => t });
    await lists.getAccounts(q(`program=${CORE}&filter=m:0:${MATCH}`));
    status = 500;
    t = 500_000;
    expect(await lists.getAccounts(q(`program=${CORE}&filter=m:0:${MATCH}`))).toHaveLength(1);
    await expect(lists.getAccounts(q(`program=${CORE}&filter=m:0:${POSITION}`))).rejects.toBeInstanceOf(GpaUpstreamError);
  });

  it("coalesces concurrent identical requests into one upstream call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fetch = (async () => {
      calls++;
      await gate;
      return Response.json({ result: [] });
    }) as typeof globalThis.fetch;
    const lists = createListCache({ fetch });
    const all = Array.from({ length: 20 }, () => lists.getAccounts(q(`program=${CORE}&filter=m:0:${MATCH}`)));
    release();
    await Promise.all(all);
    expect(calls).toBe(1);
  });

  it("replaces a shared upstream call older than the timeout instead of awaiting it", async () => {
    let t = 0;
    let calls = 0;
    const fetch = (async () => {
      calls++;
      // The first call never settles: its invocation was frozen mid-flight.
      if (calls === 1) return new Promise<Response>(() => undefined);
      return Response.json({ result: [] });
    }) as typeof globalThis.fetch;
    const lists = createListCache({ fetch, now: () => t });
    void lists.getAccounts(q(`program=${CORE}&filter=m:0:${MATCH}`)).catch(() => undefined);
    await Promise.resolve();
    t = 25_000;
    await expect(lists.getAccounts(q(`program=${CORE}&filter=m:0:${MATCH}`))).resolves.toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("gpa owner read", () => {
  it("queries upstream with the owner filter and leaves the shared list cached", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_u: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: 1, result: [row(new Uint8Array(32), ++n)] });
    }) as typeof globalThis.fetch;
    const lists = createListCache({ fetch, now: () => 1_000 });
    const owner = Keypair.generate().publicKey;
    const all = q(`program=${CORE}&filter=m:0:${HOLDING}`);
    const mine = q(`program=${CORE}&filter=m:0:${HOLDING}&filter=m:9:${owner.toBase58()}`);
    await lists.getAccounts(all);
    expect((await lists.getOwnedFresh(mine)).map((r) => r.pubkey)).toEqual(["row2"]);
    expect(JSON.parse(bodies[1]).params[1].filters).toEqual([
      { memcmp: { offset: 0, bytes: HOLDING } },
      { memcmp: { offset: 9, bytes: owner.toBase58() } },
    ]);
    expect((await lists.getAccounts(all)).map((r) => r.pubkey)).toEqual(["row1"]);
    expect(bodies).toHaveLength(2);
  });

  it("refuses a query without an owner", async () => {
    const lists = createListCache({ fetch: upstream(() => []).fetch });
    await expect(lists.getOwnedFresh(q(`program=${CORE}&filter=m:0:${HOLDING}`))).rejects.toBeInstanceOf(GpaInputError);
  });
});
