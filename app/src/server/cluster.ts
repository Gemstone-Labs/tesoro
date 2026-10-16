import { CLUSTERS, activeCluster, type ClusterSettings } from "@/lib/cluster-settings";
import { DemoHttpError } from "./request-auth";

/**
 * The routes that spend from server keys (SOL and Hoodi ETH top-ups, the relay, the Advances) run
 * only against the active cluster's chains (src/lib/cluster-settings.ts): devnet, Hoodi and HyperEVM
 * testnet in test mode, mainnet-beta, Ethereum and HyperEVM mainnet on mainnet. Checked once per RPC URL at server start (src/instrumentation.ts)
 * and before every such request; a definite mismatch is remembered, an unreachable RPC is retried.
 */
export const DEVNET_GENESIS = CLUSTERS.test.solana.genesisHash;
export const HOODI_CHAIN_ID = CLUSTERS.test.ethereum.chainId;
export const HYPEREVM_TESTNET_CHAIN_ID = CLUSTERS.test.hyperevm.chainId;

type Check = { ok: true } | { ok: false; reason: string };

async function rpc(doFetch: typeof fetch, url: string, method: string): Promise<unknown> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method}: status ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (body.result === undefined) throw new Error(`${method}: no result`);
  return body.result;
}

export function createClusterGuard(doFetch: typeof fetch = (...a) => fetch(...a), cluster: ClusterSettings = activeCluster()) {
  const checks = new Map<string, Promise<Check>>();

  function check(key: string, run: () => Promise<Check>): Promise<Check> {
    let p = checks.get(key);
    if (!p) {
      p = run().catch((e: unknown) => {
        checks.delete(key);
        return { ok: false as const, reason: `unreachable (${e instanceof Error ? e.message : String(e)})` };
      });
      checks.set(key, p);
    }
    return p;
  }

  const solana = (url: string) =>
    check(`${cluster.id}:solana:${url}`, async () => {
      const genesis = await rpc(doFetch, url, "getGenesisHash");
      return genesis === cluster.solana.genesisHash ? { ok: true } : { ok: false, reason: `genesis ${String(genesis)} is not ${cluster.solana.label}` };
    });

  const evm = (kind: "ethereum" | "hyperevm") => (url: string) =>
    check(`${cluster.id}:${kind}:${url}`, async () => {
      const id = Number(await rpc(doFetch, url, "eth_chainId"));
      const want = cluster[kind];
      return id === want.chainId ? { ok: true } : { ok: false, reason: `chain id ${id} is not ${want.label}` };
    });

  return { solana, ethereum: evm("ethereum"), hyperevm: evm("hyperevm"), hoodi: evm("ethereum"), cluster };
}

type Guard = ReturnType<typeof createClusterGuard>;

/**
 * One guard per process, shared by the instrumentation hook and the route bundles. It returns plain
 * results: the error is thrown below, so routes see their own bundle's DemoHttpError.
 */
const g = globalThis as { __tesoroClusterGuard?: Guard };
export const clusterGuard = (g.__tesoroClusterGuard ??= createClusterGuard());

async function refuseUnless(check: Promise<Check>, what: string) {
  if (!(await check).ok) throw new DemoHttpError(503, "wrong-cluster", `This server only funds ${what}.`);
}
export const requireSolana = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.solana(url), guard.cluster.solana.fundsLabel);
export const requireEthereum = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.ethereum(url), guard.cluster.ethereum.fundsLabel);
export const requireHyperEvm = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.hyperevm(url), guard.cluster.hyperevm.fundsLabel);
/** Older names for the same checks; they follow the active cluster. */
export const requireDevnet = requireSolana;
export const requireHoodi = requireEthereum;

/**
 * The SOL, ETH and HYPE top-ups and faucets are test-mode helpers: on the mainnet cluster the Player
 * pays their own fees, whichever relayer keys the host happens to hold (a copied test env must not
 * turn the routes into a faucet of real money).
 */
export function requireTestMode(cluster: ClusterSettings = activeCluster()) {
  if (cluster.id === "mainnet") throw new DemoHttpError(403, "player-pays-gas", "On mainnet you pay your own gas and the cross-chain fee.");
}
