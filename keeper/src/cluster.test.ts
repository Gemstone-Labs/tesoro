import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLUSTERS } from "../../app/src/lib/cluster-settings.ts";
import { DEVNET_GENESIS, assertDevnet, assertEthereum, assertHoodi, assertHyperEvm, assertSolana, keeperCluster, scriptRpc } from "./cluster.ts";
import { loadPayer, settings } from "./env.ts";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** A Connection stand-in that records every method called on it. */
function fakeConn(genesis: string, balance = 0) {
  const calls: string[] = [];
  const conn = new Proxy(
    { getGenesisHash: async () => genesis, getBalance: async () => balance },
    {
      get(target: any, prop: string) {
        calls.push(prop);
        if (prop in target) return target[prop];
        return () => {
          throw new Error(`unexpected call ${prop}`);
        };
      },
    },
  );
  return { conn, calls };
}

describe("cluster guard (OC-10)", () => {
  it("accepts devnet and refuses any other genesis", async () => {
    await assertDevnet({ getGenesisHash: async () => DEVNET_GENESIS }, "KEEPER_RPC");
    await assert.rejects(assertDevnet({ getGenesisHash: async () => MAINNET_GENESIS }, "KEEPER_RPC"), /not Solana devnet/);
  });

  it("accepts Hoodi and refuses any other chain id", async () => {
    await assertHoodi({ getChainId: async () => 560048 });
    await assert.rejects(assertHoodi({ getChainId: async () => 1 }), /not Hoodi/);
    await assert.rejects(assertHoodi({ getChainId: async () => 998 }), /not Hoodi/);
  });

  it("accepts HyperEVM testnet and refuses any other chain id", async () => {
    await assertHyperEvm({ getChainId: async () => 998 });
    await assert.rejects(assertHyperEvm({ getChainId: async () => 560048 }), /not HyperEVM testnet/);
  });

  it("refuses to load the payer on a mainnet RPC, before touching any key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const s = { ...settings([], { KEEPER_KEYPAIR: join(dir, "keeper.json") } as NodeJS.ProcessEnv) };
    const { conn, calls } = fakeConn(MAINNET_GENESIS);
    await assert.rejects(loadPayer(conn, s, () => {}), /not Solana devnet/);
    assert.deepEqual(calls, ["getGenesisHash"]);
  });

  it("refuses when only the list RPC is another cluster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const s = { ...settings([], { KEEPER_KEYPAIR: join(dir, "keeper.json"), KEEPER_GPA_RPC: "http://other" } as NodeJS.ProcessEnv) };
    await assert.rejects(loadPayer(fakeConn(DEVNET_GENESIS).conn, s, () => {}, fakeConn(MAINNET_GENESIS).conn), /KEEPER_GPA_RPC RPC is not Solana devnet/);
  });

  it("never funds an empty payer: it only reads the balance and warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const s = { ...settings([], { KEEPER_KEYPAIR: join(dir, "keeper.json"), KEEPER_FUNDER: join(dir, "funder.json") } as NodeJS.ProcessEnv) };
    const { conn, calls } = fakeConn(DEVNET_GENESIS, 0);
    const lines: string[] = [];
    await loadPayer(conn, s, (m) => lines.push(m));
    assert.deepEqual(calls, ["getGenesisHash", "getBalance"]);
    assert.ok(lines.some((l) => l.startsWith("WARN payer")));
  });
});

describe("mainnet cluster", () => {
  const main = CLUSTERS.mainnet;

  it("TESORO_CLUSTER picks the cluster; unset is test; unknown throws", () => {
    assert.equal(keeperCluster({} as NodeJS.ProcessEnv).id, "test");
    assert.equal(keeperCluster({ TESORO_CLUSTER: "mainnet" } as NodeJS.ProcessEnv).id, "mainnet");
    assert.throws(() => keeperCluster({ TESORO_CLUSTER: "devnet" } as NodeJS.ProcessEnv), /Unknown cluster/);
  });

  it("accepts mainnet-beta and refuses devnet", async () => {
    await assertSolana({ getGenesisHash: async () => main.solana.genesisHash }, "KEEPER_RPC", main);
    await assert.rejects(assertSolana({ getGenesisHash: async () => DEVNET_GENESIS }, "KEEPER_RPC", main), /not Solana mainnet-beta/);
  });

  it("accepts Ethereum 1 and HyperEVM 999 and refuses the test chains", async () => {
    await assertEthereum({ getChainId: async () => 1 }, main);
    await assertHyperEvm({ getChainId: async () => 999 }, main);
    await assert.rejects(assertEthereum({ getChainId: async () => 560048 }, main), /not Ethereum mainnet/);
    await assert.rejects(assertHyperEvm({ getChainId: async () => 998 }, main), /not HyperEVM mainnet/);
  });

  it("mainnet settings have no default RPC", () => {
    assert.throws(() => settings([], { TESORO_CLUSTER: "mainnet" } as NodeJS.ProcessEnv), /KEEPER_RPC is not set/);
  });

  it("scripts take RPC_URL, else the test default; mainnet must set it", () => {
    assert.equal(scriptRpc({} as NodeJS.ProcessEnv), CLUSTERS.test.solana.defaultRpc);
    assert.equal(scriptRpc({ RPC_URL: "https://x" } as NodeJS.ProcessEnv), "https://x");
    assert.throws(() => scriptRpc({ TESORO_CLUSTER: "mainnet" } as NodeJS.ProcessEnv), /RPC_URL is not set/);
  });
});
