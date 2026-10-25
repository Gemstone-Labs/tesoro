import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLUSTERS, magicblockSettings, resolveCluster } from "./cluster-settings";

describe("cluster settings", () => {
  it("test mode keeps today's values", () => {
    const t = CLUSTERS.test;
    expect(t.entrySizes).toEqual([100, 500, 1000]);
    expect(t.defaultHorizonMonths).toBe(1);
    expect(t).toMatchObject({ yieldModel: "simulated", priceSource: "keeper", inviteRequired: false });
    expect(t.solana.genesisHash).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect([t.ethereum.chainId, t.hyperevm.chainId]).toEqual([560048, 998]);
  });

  it("mainnet values", () => {
    const m = CLUSTERS.mainnet;
    expect(m.entrySizes).toEqual([100, 500, 1000]);
    expect(m.defaultHorizonMonths).toBe(12);
    expect(m).toMatchObject({ yieldModel: "real", priceSource: "onchain", inviteRequired: true });
    expect(m.solana.genesisHash).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect([m.ethereum.chainId, m.hyperevm.chainId]).toEqual([1, 999]);
  });

  it("defaults to test, selects mainnet, and throws on anything else", () => {
    expect(resolveCluster(undefined).id).toBe("test");
    expect(resolveCluster("").id).toBe("test");
    expect(resolveCluster("mainnet").id).toBe("mainnet");
    expect(() => resolveCluster("devnet")).toThrow(/Unknown cluster/);
  });

  it("MagicBlock: test mode keeps the devnet endpoints and TEE validator", () => {
    expect(CLUSTERS.test.magicblock).toMatchObject({
      erRpc: "https://devnet.magicblock.app",
      erWs: "wss://devnet.magicblock.app",
      teeRpc: "https://devnet-tee.magicblock.app",
      teeWs: "wss://devnet-tee.magicblock.app",
      teeValidator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
    });
    expect(CLUSTERS.test.solana.defaultRpc).toBe("https://rpc.magicblock.app/devnet");
  });

  it("MagicBlock: mainnet points at the mainnet TEE and ER, no devnet host anywhere", () => {
    const m = CLUSTERS.mainnet.magicblock;
    expect(m).toMatchObject({ teeRpc: "https://mainnet-tee.magicblock.app", teeWs: "wss://mainnet-tee.magicblock.app", erRpc: "https://us.magicblock.app", erWs: "wss://us.magicblock.app" });
    expect(m.teeValidator).toBe("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
    expect(JSON.stringify(m)).not.toMatch(/devnet/);
    expect(CLUSTERS.mainnet.solana.defaultRpc).toBeUndefined();
  });

  it("MagicBlock: env overrides the URLs, never the validator, and rejects bad schemes", () => {
    const m = magicblockSettings(CLUSTERS.mainnet, { MAGICBLOCK_ER_RPC: "https://eu.magicblock.app", NEXT_PUBLIC_MAGICBLOCK_TEE_WS: "wss://tee.example" });
    expect(m.erRpc).toBe("https://eu.magicblock.app");
    expect(m.teeWs).toBe("wss://tee.example");
    expect(m.teeRpc).toBe("https://mainnet-tee.magicblock.app");
    expect(m.teeValidator).toBe(CLUSTERS.mainnet.magicblock.teeValidator);
    expect(() => magicblockSettings(CLUSTERS.test, { MAGICBLOCK_TEE_RPC: "wss://x" })).toThrow(/TEE_RPC must be a http/);
  });
});

describe("entry sizes match the program", () => {
  // tesoro_core uses ledger::LADDER while Config.entry_sizes is unset, as on devnet. If the app
  // offers other sizes, entry fails on chain: change both together.
  const src = readFileSync(new URL("../../../programs/tesoro_core/src/ledger/mod.rs", import.meta.url), "utf8");
  const ladder = /pub const LADDER: \[u64; \d+\] = \[([^\]]+)\];/.exec(src)?.[1];

  it("test mode offers exactly the program's default LADDER", () => {
    expect(ladder, "LADDER not found in programs/tesoro_core/src/ledger/mod.rs").toBeDefined();
    expect(CLUSTERS.test.entrySizes).toEqual(ladder!.split(",").map((n) => Number(n.trim().replaceAll("_", ""))));
  });
});
