import { describe, expect, it, vi } from "vitest";
import { rpcFetch } from "./rpc-fetch";

const PRIMARY = "https://primary.example/rpc";
const FALLBACK = "https://fallback.example/rpc";
const ok = () => new Response('{"jsonrpc":"2.0","result":1,"id":1}', { status: 200 });
const down = () => new Response('{"jsonrpc":"2.0","error":{"code":503,"message":"Service unavailable"},"id": null}', { status: 503 });

function harness(replies: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = replies.shift();
    if (!next) throw new Error("no reply left");
    return next();
  }) as unknown as typeof fetch;
  return { calls, f: rpcFetch({ fallback: FALLBACK, fetchImpl, delayMs: 0 }) };
}

describe("rpcFetch", () => {
  it("returns the first answer when the RPC is up", async () => {
    const { calls, f } = harness([ok]);
    expect((await f(PRIMARY, { method: "POST" })).status).toBe(200);
    expect(calls).toEqual([PRIMARY]);
  });

  it("retries a 503 and ends on the fallback RPC", async () => {
    const { calls, f } = harness([down, down, ok]);
    expect((await f(PRIMARY, { method: "POST" })).status).toBe(200);
    expect(calls).toEqual([PRIMARY, PRIMARY, FALLBACK]);
  });

  it("retries a dropped connection", async () => {
    const { calls, f } = harness([
      () => {
        throw new TypeError("Failed to fetch");
      },
      ok,
    ]);
    expect((await f(PRIMARY, { method: "POST" })).status).toBe(200);
    expect(calls).toEqual([PRIMARY, PRIMARY]);
  });

  it("does not retry an answer that is not an outage", async () => {
    const { calls, f } = harness([() => new Response("bad", { status: 400 })]);
    expect((await f(PRIMARY, { method: "POST" })).status).toBe(400);
    expect(calls).toEqual([PRIMARY]);
  });

  it("hands back the last 503 when every try fails", async () => {
    const { calls, f } = harness([down, down, down]);
    expect((await f(PRIMARY, { method: "POST" })).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("stays on the primary RPC without a fallback", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return calls.length < 3 ? down() : ok();
    }) as typeof fetch;
    expect((await rpcFetch({ fetchImpl, delayMs: 0 })(PRIMARY, {})).status).toBe(200);
    expect(calls).toEqual([PRIMARY, PRIMARY, PRIMARY]);
  });
});
