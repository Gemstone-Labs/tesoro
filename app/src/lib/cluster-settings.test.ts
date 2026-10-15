import { describe, expect, it } from "vitest";
import { CLUSTERS, resolveCluster } from "./cluster-settings";

describe("cluster settings", () => {
  it("test mode keeps today's values", () => {
    const t = CLUSTERS.test;
    expect(t.entrySizes).toEqual([500, 1000, 2500]);
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
});
