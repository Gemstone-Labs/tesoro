/**
 * Every value that differs between test mode and mainnet, in one place. The app, the server routes
 * and the keeper read it; nothing else hard-codes a chain id, entry size or default Horizon.
 * No imports: the keeper loads this file by relative path.
 *
 * The active cluster is TESORO_CLUSTER (server, keeper) or NEXT_PUBLIC_TESORO_CLUSTER (browser):
 * "test" or "mainnet", default test. Any other value throws; there is no silent fallback.
 */

export type ClusterId = "test" | "mainnet";

export interface EvmChainSettings {
  chainId: number;
  /** Full name used in error messages: "not <label>". */
  label: string;
  /** Short name used in "This server only funds <fundsLabel>". */
  fundsLabel: string;
  /** Env var holding this chain's RPC URL (browser/server). */
  rpcEnv: string;
}

export interface ClusterSettings {
  id: ClusterId;
  /** Gemas a Player puts in a Match. Points stay one per 100 Gemas of entry. */
  entrySizes: readonly number[];
  defaultHorizonMonths: number;
  yieldModel: "simulated" | "real";
  /** Who writes the prices Advances read: the keeper's price job, or on-chain feeds. */
  priceSource: "keeper" | "onchain";
  inviteRequired: boolean;
  solana: {
    genesisHash: string;
    label: string;
    fundsLabel: string;
    /** Server base-layer RPC (not the Base chain). */
    serverRpcEnv: string;
    /** Browser RPC. */
    browserRpcEnv: string;
    /** Server list-query (getProgramAccounts) RPC. */
    gpaRpcEnv: string;
  };
  ethereum: EvmChainSettings;
  hyperevm: EvmChainSettings;
}

export const CLUSTERS: Record<ClusterId, ClusterSettings> = {
  test: {
    id: "test",
    entrySizes: [500, 1000, 2500],
    defaultHorizonMonths: 1,
    yieldModel: "simulated",
    priceSource: "keeper",
    inviteRequired: false,
    solana: {
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      label: "Solana devnet",
      fundsLabel: "devnet",
      serverRpcEnv: "TESORO_BASE_RPC",
      browserRpcEnv: "NEXT_PUBLIC_SOLANA_RPC",
      gpaRpcEnv: "TESORO_GPA_RPC",
    },
    ethereum: { chainId: 560048, label: "Hoodi", fundsLabel: "Hoodi", rpcEnv: "NEXT_PUBLIC_HOODI_RPC" },
    hyperevm: { chainId: 998, label: "HyperEVM testnet", fundsLabel: "HyperEVM testnet", rpcEnv: "NEXT_PUBLIC_HYPEREVM_RPC" },
  },
  mainnet: {
    id: "mainnet",
    entrySizes: [100, 500, 1000],
    defaultHorizonMonths: 12,
    yieldModel: "real",
    priceSource: "onchain",
    inviteRequired: true,
    solana: {
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      label: "Solana mainnet-beta",
      fundsLabel: "Solana mainnet-beta",
      serverRpcEnv: "TESORO_BASE_RPC",
      browserRpcEnv: "NEXT_PUBLIC_SOLANA_RPC",
      gpaRpcEnv: "TESORO_GPA_RPC",
    },
    ethereum: { chainId: 1, label: "Ethereum mainnet", fundsLabel: "Ethereum mainnet", rpcEnv: "NEXT_PUBLIC_ETHEREUM_RPC" },
    hyperevm: { chainId: 999, label: "HyperEVM mainnet", fundsLabel: "HyperEVM mainnet", rpcEnv: "NEXT_PUBLIC_HYPEREVM_RPC" },
  },
};

/** Throws on a value that is not a cluster; unset or empty means test. */
export function resolveCluster(raw: string | undefined | null): ClusterSettings {
  const id = raw?.trim() || "test";
  if (id !== "test" && id !== "mainnet") throw new Error(`Unknown cluster "${id}": set TESORO_CLUSTER to "test" or "mainnet"`);
  return CLUSTERS[id];
}

/**
 * The cluster this process runs. The browser bundle only sees NEXT_PUBLIC_ variables and Next inlines
 * them only when written out in full, so both names are spelled out here.
 */
export function activeCluster(): ClusterSettings {
  return resolveCluster(process.env.NEXT_PUBLIC_TESORO_CLUSTER || process.env.TESORO_CLUSTER);
}

export const CLUSTER = activeCluster();
export const ENTRY_SIZES: readonly number[] = CLUSTER.entrySizes;
export const DEFAULT_HORIZON_MONTHS = CLUSTER.defaultHorizonMonths;
