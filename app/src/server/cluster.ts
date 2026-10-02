import { DemoHttpError } from "./request-auth";

/**
 * The routes that spend from server keys (SOL and Hoodi ETH top-ups, the relay, the Advances) run
 * only against Solana devnet and Hoodi. Checked once per RPC URL at server start (src/instrumentation.ts)
 * and before every such request; a definite mismatch is remembered, an unreachable RPC is retried.
 */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const HOODI_CHAIN_ID = 560048;
export const HYPEREVM_TESTNET_CHAIN_ID = 998;

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

export function createClusterGuard(doFetch: typeof fetch = (...a) => fetch(...a)) {
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
    check(`solana:${url}`, async () => {
      const genesis = await rpc(doFetch, url, "getGenesisHash");
      return genesis === DEVNET_GENESIS ? { ok: true } : { ok: false, reason: `genesis ${String(genesis)} is not devnet` };
    });

  const hoodi = (url: string) =>
    check(`hoodi:${url}`, async () => {
      const id = Number(await rpc(doFetch, url, "eth_chainId"));
      return id === HOODI_CHAIN_ID ? { ok: true } : { ok: false, reason: `chain id ${id} is not Hoodi` };
    });

  const hyperevm = (url: string) =>
    check(`hyperevm:${url}`, async () => {
      const id = Number(await rpc(doFetch, url, "eth_chainId"));
      return id === HYPEREVM_TESTNET_CHAIN_ID ? { ok: true } : { ok: false, reason: `chain id ${id} is not HyperEVM testnet` };
    });

  return { solana, hoodi, hyperevm };
}

type Guard = ReturnType<typeof createClusterGuard>;

/**
 * One guard per process, shared by the instrumentation hook and the route bundles. It returns plain
 * results: the error is thrown below, so routes see their own bundle's DemoHttpError.
 */
const g = globalThis as { __tesoroClusterGuard?: Guard };
export const clusterGuard = (g.__tesoroClusterGuard ??= createClusterGuard());

async function refuseUnless(check: Promise<Check>, cluster: string) {
  if (!(await check).ok) throw new DemoHttpError(503, "wrong-cluster", `This server only funds ${cluster}.`);
}
export const requireDevnet = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.solana(url), "devnet");
export const requireHoodi = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.hoodi(url), "Hoodi");
export const requireHyperEvm = (url: string, guard: Guard = clusterGuard) => refuseUnless(guard.hyperevm(url), "HyperEVM testnet");
