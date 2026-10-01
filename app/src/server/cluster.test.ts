import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS, createClusterGuard } from "./cluster";
import { DemoHttpError } from "./request-auth";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function rpc(answer: (method: string) => unknown) {
  let calls = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    const { method } = JSON.parse(String(init.body)) as { method: string };
    const r = answer(method);
    if (r instanceof Error) throw r;
    return Response.json({ jsonrpc: "2.0", id: 1, result: r });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

describe("cluster guard (OC-10)", () => {
  it("allows devnet and Hoodi, checking each RPC once", async () => {
    const up = rpc((m) => (m === "getGenesisHash" ? DEVNET_GENESIS : "0x88bb0"));
    const guard = createClusterGuard(up.fetch);
    await guard.requireDevnet("a");
    await guard.requireDevnet("a");
    await guard.requireHoodi("h");
    expect(up.calls()).toBe(2);
  });

  it("refuses mainnet and other EVM chains", async () => {
    const guard = createClusterGuard(rpc((m) => (m === "getGenesisHash" ? MAINNET_GENESIS : "0x1")).fetch);
    await expect(guard.requireDevnet("m")).rejects.toMatchObject({ code: "wrong-cluster", status: 503 });
    await expect(guard.requireHoodi("e")).rejects.toBeInstanceOf(DemoHttpError);
    expect(await guard.solana("m")).toMatchObject({ ok: false, reason: expect.stringContaining(MAINNET_GENESIS) });
  });

  it("an unreachable RPC is refused now and asked again next time", async () => {
    let down = true;
    const up = rpc(() => (down ? new Error("ECONNREFUSED") : DEVNET_GENESIS));
    const guard = createClusterGuard(up.fetch);
    await expect(guard.requireDevnet("x")).rejects.toMatchObject({ code: "wrong-cluster" });
    down = false;
    await guard.requireDevnet("x");
    expect(up.calls()).toBe(2);
  });
});
