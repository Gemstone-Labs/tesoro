import { DEFAULT_BASE_RPC } from "./rpc-config";

/** Base-layer devnet RPC for single-account reads and sends. Lists go through /api/chain/accounts (app/docs/rpc.md). */
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC || DEFAULT_BASE_RPC;

/**
 * Dev-only fallback signer: a local Keypair per browser instead of Privy. The `NODE_ENV` check is
 * inlined at build time, so production bundles never contain the branch.
 */
export const DEV_WALLET = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEV_WALLET === "1";

/** Below this SOL balance the demo faucet tops the wallet up (rent and fees for Match, Session, Boards). */
export const MIN_SOL_LAMPORTS = 50_000_000;
