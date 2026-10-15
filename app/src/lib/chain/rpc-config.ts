import { CLUSTER } from "../cluster-settings";

/**
 * RPC endpoints by role. See app/docs/rpc.md.
 *  - NEXT_PUBLIC_SOLANA_RPC: browser reads and sends (single-account reads, confirmations).
 *  - TESORO_BASE_RPC: server reads and sends.
 *  - TESORO_GPA_RPC: server only, list queries (getProgramAccounts). Never sent to the browser.
 */
/** Test-mode defaults. Mainnet has none: use baseRpc()/gpaRpc(), which throw when the env var is unset. */
export const DEFAULT_BASE_RPC = "https://rpc.magicblock.app/devnet";
/** MagicBlock serves getProgramAccounts on base-layer devnet without the public RPC's per-IP limit (QA 2026-09-30: api.devnet.solana.com answered "Rate limited upstream" with three browsers and the keeper). */
export const DEFAULT_GPA_RPC = "https://rpc.magicblock.app/devnet";

/** Browser list queries go through this route instead of a per-tab getProgramAccounts. */
export const GPA_ROUTE = "/api/chain/accounts";

function withDefault(name: string, value: string | undefined, testDefault: string): string {
  if (value) return value;
  if (CLUSTER.id === "test") return testDefault;
  throw new Error(`${name} is not set; mainnet has no default RPC`);
}
export const baseRpc = (value: string | undefined) => withDefault(CLUSTER.solana.serverRpcEnv, value, DEFAULT_BASE_RPC);
export const gpaRpc = (value: string | undefined) => withDefault(CLUSTER.solana.gpaRpcEnv, value, DEFAULT_GPA_RPC);
