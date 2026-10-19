import type { ClusterId } from "./cluster-settings";

export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_DEVNET_WS = "wss://api.devnet.solana.com";

/**
 * The Solana network the sign-in wallet is configured for: the CAIP key and its RPC/WebSocket. Mainnet
 * has no public default; the browser RPC (a Helius URL) is required and its socket is the same URL.
 */
export function solanaNetwork(cluster: ClusterId, browserRpc: string | undefined): { key: string; rpc: string; ws: string } {
  if (cluster === "test") return { key: "solana:devnet", rpc: SOLANA_DEVNET_RPC, ws: SOLANA_DEVNET_WS };
  if (!browserRpc) throw new Error("NEXT_PUBLIC_SOLANA_RPC is not set; mainnet has no default RPC");
  return { key: "solana:mainnet", rpc: browserRpc, ws: browserRpc.replace(/^http/, "ws") };
}
