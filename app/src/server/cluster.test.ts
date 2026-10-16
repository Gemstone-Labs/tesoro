import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS, createClusterGuard, requireDevnet, requireHoodi, requireHyperEvm, requireTestMode } from "./cluster";
import { CLUSTERS } from "@/lib/cluster-settings";
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
    await requireDevnet("a", guard);
    await requireDevnet("a", guard);
    await requireHoodi("h", guard);
    expect(up.calls()).toBe(2);
  });

  it("refuses mainnet and other EVM chains", async () => {
    const guard = createClusterGuard(rpc((m) => (m === "getGenesisHash" ? MAINNET_GENESIS : "0x1")).fetch);
    await expect(requireDevnet("m", guard)).rejects.toMatchObject({ code: "wrong-cluster", status: 503 });
    await expect(requireHoodi("e", guard)).rejects.toBeInstanceOf(DemoHttpError);
    expect(await guard.solana("m")).toMatchObject({ ok: false, reason: expect.stringContaining(MAINNET_GENESIS) });
  });

  it("an unreachable RPC is refused now and asked again next time", async () => {
    let down = true;
    const up = rpc(() => (down ? new Error("ECONNREFUSED") : DEVNET_GENESIS));
    const guard = createClusterGuard(up.fetch);
    await expect(requireDevnet("x", guard)).rejects.toMatchObject({ code: "wrong-cluster" });
    down = false;
    await requireDevnet("x", guard);
    expect(up.calls()).toBe(2);
  });
});

describe("HyperEVM guard", () => {
  it("allows chain 998 only", async () => {
    await requireHyperEvm("ok", createClusterGuard(rpc(() => "0x3e6").fetch));
    await expect(requireHyperEvm("main", createClusterGuard(rpc(() => "0x3e7").fetch))).rejects.toMatchObject({ code: "wrong-cluster", status: 503 });
  });
});

describe("mainnet cluster guard", () => {
  const main = CLUSTERS.mainnet;
  it("accepts mainnet-beta, Ethereum 1 and HyperEVM 999, and refuses devnet and the test chains", async () => {
    const solana = createClusterGuard(rpc(() => main.solana.genesisHash).fetch, main);
    expect(await solana.solana("a")).toEqual({ ok: true });
    expect(await createClusterGuard(rpc(() => "0x1").fetch, main).ethereum("e")).toEqual({ ok: true });
    expect(await createClusterGuard(rpc(() => "0x3e7").fetch, main).hyperevm("h")).toEqual({ ok: true });
    expect(await createClusterGuard(rpc(() => DEVNET_GENESIS).fetch, main).solana("d")).toMatchObject({ ok: false, reason: expect.stringContaining("not Solana mainnet-beta") });
    expect(await createClusterGuard(rpc(() => "0x88bb0").fetch, main).ethereum("e")).toMatchObject({ ok: false });
    expect(await createClusterGuard(rpc(() => "0x3e6").fetch, main).hyperevm("h")).toMatchObject({ ok: false });
  });

  it("the same RPC is checked separately per cluster", async () => {
    const up = rpc(() => main.solana.genesisHash);
    expect(await createClusterGuard(up.fetch, main).solana("x")).toEqual({ ok: true });
    expect(await createClusterGuard(up.fetch, CLUSTERS.test).solana("x")).toMatchObject({ ok: false });
  });
});

describe("server-paid fees (audit 2026-10-16, M-1)", () => {
  it("are refused on the mainnet cluster whatever keys the host holds, and allowed in test mode", () => {
    expect(() => requireTestMode(CLUSTERS.test)).not.toThrow();
    try {
      requireTestMode(CLUSTERS.mainnet);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(DemoHttpError);
      expect((e as DemoHttpError).code).toBe("player-pays-gas");
      expect((e as DemoHttpError).status).toBe(403);
    }
  });
});
