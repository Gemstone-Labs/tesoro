import { CLUSTERS, resolveCluster, type ClusterSettings } from "../../app/src/lib/cluster-settings.ts";

/** The keeper's cluster: TESORO_CLUSTER, default test. An unknown value throws. */
export const keeperCluster = (env: NodeJS.ProcessEnv = process.env): ClusterSettings => resolveCluster(env.TESORO_CLUSTER);

/** Test-mode values, kept under their old names. */
export const DEVNET_GENESIS = CLUSTERS.test.solana.genesisHash;
export const HOODI_CHAIN_ID = CLUSTERS.test.ethereum.chainId;
export const HYPEREVM_CHAIN_ID = CLUSTERS.test.hyperevm.chainId;

/** Throws unless the RPC behind `conn` serves the cluster's Solana network. */
export async function assertSolana(conn: { getGenesisHash(): Promise<string> }, label: string, cluster: ClusterSettings = keeperCluster()): Promise<void> {
  const hash = await conn.getGenesisHash();
  if (hash !== cluster.solana.genesisHash) throw new Error(`${label} RPC is not ${cluster.solana.label} (genesis ${hash}); the keeper runs on ${cluster.solana.label} only`);
}

type Evm = { getChainId(): Promise<number> };

async function assertChain(pub: Evm, want: { chainId: number; label: string }): Promise<void> {
  const id = await pub.getChainId();
  if (id !== want.chainId) throw new Error(`EVM RPC is chain ${id}, not ${want.label} (${want.chainId}); reportYield refused`);
}

/** Throws unless the EVM RPC serves the cluster's Ethereum chain (Hoodi in test mode). */
export const assertEthereum = (pub: Evm, cluster: ClusterSettings = keeperCluster()) => assertChain(pub, cluster.ethereum);

/** Throws unless the EVM RPC serves the cluster's HyperEVM chain. */
export const assertHyperEvm = (pub: Evm, cluster: ClusterSettings = keeperCluster()) => assertChain(pub, cluster.hyperevm);

/** Older names for the same checks; they follow the active cluster. */
export const assertDevnet = assertSolana;
export const assertHoodi = assertEthereum;

/** The RPC a one-off script uses: `RPC_URL`, else the cluster's public default (test mode only; mainnet must set it). */
export function scriptRpc(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.RPC_URL || keeperCluster(env).solana.defaultRpc;
  if (!url) throw new Error("RPC_URL is not set; mainnet has no default RPC");
  return url;
}
