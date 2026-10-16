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

/**
 * MagicBlock endpoints and the one validator Game accounts may be delegated to.
 * Sources: docs.magicblock.gg "Local setup" / RPC API (validator identities, hostnames), checked live with
 * `getIdentity` and `getAccountInfo` on 2026-10-16: mainnet-tee and devnet-tee both answer MTEWGuqx...; us.magicblock.app
 * answers MUS3hc9T... (docs list as/eu/us for mainnet, devnet-as/-eu/-us for devnet).
 */
export interface MagicBlockSettings {
  /** Public (non-private) ephemeral rollup: the Trading Duel price feeds. */
  erRpc: string;
  erWs: string;
  /** Private rollup (Intel TDX): Match state of every Game. */
  teeRpc: string;
  teeWs: string;
  /** The TEE validator pubkey Game programs whitelist and delegate to. Not overridable by env. */
  teeValidator: string;
  /** MagicBlock's Pyth Lazer feed accounts inside the rollup (same addresses on devnet and mainnet rollups, checked live). */
  priceFeeds: { SOL: string; ETH: string; HYPE: string };
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
    /** Test-mode public RPCs used when the env var is unset. Mainnet has none: an unset RPC is an error. */
    defaultRpc?: string;
    defaultGpaRpc?: string;
  };
  ethereum: EvmChainSettings;
  hyperevm: EvmChainSettings;
  magicblock: MagicBlockSettings;
}

const MAGICBLOCK_TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const MAGICBLOCK_PRICE_FEEDS = {
  SOL: "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
  ETH: "5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG",
  HYPE: "CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x",
};

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
      defaultRpc: "https://rpc.magicblock.app/devnet",
      defaultGpaRpc: "https://rpc.magicblock.app/devnet",
    },
    ethereum: { chainId: 560048, label: "Hoodi", fundsLabel: "Hoodi", rpcEnv: "NEXT_PUBLIC_HOODI_RPC" },
    hyperevm: { chainId: 998, label: "HyperEVM testnet", fundsLabel: "HyperEVM testnet", rpcEnv: "NEXT_PUBLIC_HYPEREVM_RPC" },
    magicblock: {
      erRpc: "https://devnet.magicblock.app",
      erWs: "wss://devnet.magicblock.app",
      teeRpc: "https://devnet-tee.magicblock.app",
      teeWs: "wss://devnet-tee.magicblock.app",
      teeValidator: MAGICBLOCK_TEE_VALIDATOR,
      priceFeeds: MAGICBLOCK_PRICE_FEEDS,
    },
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
    magicblock: {
      erRpc: "https://us.magicblock.app",
      erWs: "wss://us.magicblock.app",
      teeRpc: "https://mainnet-tee.magicblock.app",
      teeWs: "wss://mainnet-tee.magicblock.app",
      teeValidator: MAGICBLOCK_TEE_VALIDATOR,
      priceFeeds: MAGICBLOCK_PRICE_FEEDS,
    },
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

type Env = Record<string, string | undefined>;

/**
 * The cluster's MagicBlock endpoints. The four URLs can be overridden (another region, a private TEE gateway) with
 * NEXT_PUBLIC_MAGICBLOCK_ER_RPC / _ER_WS / _TEE_RPC / _TEE_WS (or the same names without NEXT_PUBLIC_ on the server and keeper);
 * the validator never can. An override that is not an http(s)/ws(s) URL throws.
 */
export function magicblockSettings(cluster: ClusterSettings, env: Env): MagicBlockSettings {
  const pick = (key: string, scheme: RegExp, fallback: string) => {
    const v = (env[`NEXT_PUBLIC_MAGICBLOCK_${key}`] || env[`MAGICBLOCK_${key}`])?.trim();
    if (!v) return fallback;
    if (!scheme.test(v)) throw new Error(`MAGICBLOCK_${key} must be a ${scheme === HTTP ? "http(s)" : "ws(s)"} URL, got "${v}"`);
    return v;
  };
  const m = cluster.magicblock;
  return {
    ...m,
    erRpc: pick("ER_RPC", HTTP, m.erRpc),
    erWs: pick("ER_WS", WS, m.erWs),
    teeRpc: pick("TEE_RPC", HTTP, m.teeRpc),
    teeWs: pick("TEE_WS", WS, m.teeWs),
  };
}
const HTTP = /^https?:\/\//;
const WS = /^wss?:\/\//;

/** Browser bundles only see NEXT_PUBLIC_ variables Next can inline, so each is spelled out in full. */
export function activeMagicblock(): MagicBlockSettings {
  return magicblockSettings(CLUSTER, {
    NEXT_PUBLIC_MAGICBLOCK_ER_RPC: process.env.NEXT_PUBLIC_MAGICBLOCK_ER_RPC,
    NEXT_PUBLIC_MAGICBLOCK_ER_WS: process.env.NEXT_PUBLIC_MAGICBLOCK_ER_WS,
    NEXT_PUBLIC_MAGICBLOCK_TEE_RPC: process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC,
    NEXT_PUBLIC_MAGICBLOCK_TEE_WS: process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_WS,
    MAGICBLOCK_ER_RPC: process.env.MAGICBLOCK_ER_RPC,
    MAGICBLOCK_ER_WS: process.env.MAGICBLOCK_ER_WS,
    MAGICBLOCK_TEE_RPC: process.env.MAGICBLOCK_TEE_RPC,
    MAGICBLOCK_TEE_WS: process.env.MAGICBLOCK_TEE_WS,
  });
}
export const CLUSTER = activeCluster();
export const MAGICBLOCK = activeMagicblock();
export const ENTRY_SIZES: readonly number[] = CLUSTER.entrySizes;
export const DEFAULT_HORIZON_MONTHS = CLUSTER.defaultHorizonMonths;
