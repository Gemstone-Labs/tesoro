/** Server start: the routes that spend from server keys refuse to run unless the RPCs are devnet and Hoodi. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { clusterGuard } = await import("./server/cluster");
  const { DEFAULT_BASE_RPC } = await import("./lib/chain/rpc-config");
  const solanaRpc = process.env.TESORO_BASE_RPC || DEFAULT_BASE_RPC;
  const hoodiRpc = process.env.NEXT_PUBLIC_HOODI_RPC ?? "https://ethereum-hoodi-rpc.publicnode.com";
  const [solana, hoodi] = await Promise.all([clusterGuard.solana(solanaRpc), clusterGuard.hoodi(hoodiRpc)]);
  if (solana.ok) console.info("[cluster] TESORO_BASE_RPC is Solana devnet");
  else console.error(`[cluster] SOL top-up, relay and Advance routes refused: TESORO_BASE_RPC ${solana.reason}`);
  if (hoodi.ok) console.info("[cluster] Hoodi RPC is chain 560048");
  else console.error(`[cluster] Hoodi ETH top-up refused: ${hoodi.reason}`);
}
