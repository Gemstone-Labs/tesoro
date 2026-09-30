/**
 * RPC endpoints by role. See app/docs/rpc.md.
 *  - NEXT_PUBLIC_SOLANA_RPC: browser reads and sends (single-account reads, confirmations).
 *  - TESORO_BASE_RPC: server reads and sends.
 *  - TESORO_GPA_RPC: server only, list queries (getProgramAccounts). Never sent to the browser.
 */
export const DEFAULT_BASE_RPC = "https://rpc.magicblock.app/devnet";
export const DEFAULT_GPA_RPC = "https://api.devnet.solana.com";

/** Browser list queries go through this route instead of a per-tab getProgramAccounts. */
export const GPA_ROUTE = "/api/chain/accounts";
