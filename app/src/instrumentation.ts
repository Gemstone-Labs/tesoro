/** Server start: the routes that spend from server keys refuse to run unless the RPCs belong to the active cluster. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { clusterGuard } = await import("./server/cluster");
  const { baseRpc } = await import("./lib/chain/rpc-config");
  const { HOODI_RPC } = await import("./lib/chains");
  const { cluster } = clusterGuard;
  const [solana, ethereum] = await Promise.all([
    clusterGuard.solana(baseRpc(process.env.TESORO_BASE_RPC)),
    clusterGuard.ethereum(HOODI_RPC),
  ]);
  if (solana.ok) console.info(`[cluster] ${cluster.solana.serverRpcEnv} is ${cluster.solana.label}`);
  else console.error(`[cluster] SOL top-up, relay and Advance routes refused: ${cluster.solana.serverRpcEnv} ${solana.reason}`);
  if (ethereum.ok) console.info(`[cluster] ${cluster.ethereum.label} RPC is chain ${cluster.ethereum.chainId}`);
  else console.error(`[cluster] ${cluster.ethereum.label} top-up refused: ${ethereum.reason}`);
}
