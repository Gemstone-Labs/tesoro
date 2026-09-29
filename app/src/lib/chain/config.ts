/** Base-layer devnet RPC. The public api.devnet.solana.com rate-limits; this one is the same chain. */
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";

/**
 * Dev-only fallback signer: a local Keypair per browser instead of Privy. The `NODE_ENV` check is
 * inlined at build time, so production bundles never contain the branch.
 */
export const DEV_WALLET = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEV_WALLET === "1";

/** Below this SOL balance the demo faucet tops the wallet up (rent and fees for Match, Session, Boards). */
export const MIN_SOL_LAMPORTS = 50_000_000;

/**
 * Dev-only: shows the old oracle-signed "Simulated · demo Advance" on the Wallet. The default funding
 * path is a real native Position (simSOL faucet, then Open a Position). Inlined at build time, never in production.
 */
export const DEMO_ADVANCE = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEMO_ADVANCE === "1";
