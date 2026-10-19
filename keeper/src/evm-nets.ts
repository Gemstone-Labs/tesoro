import { defineChain } from "viem";
import { keeperCluster } from "./cluster.ts";
import type { Settings } from "./env.ts";

/** The EVM chains Tesoro vaults live on. The keeper only reads their native balances (alerts); it sends nothing there. */
export interface EvmNet {
  /** tesoro_core `source_chain` variant. */
  chain: "ethereum" | "hyperEvm";
  name: string;
  /** Native token. */
  unit: "ETH" | "HYPE";
  rpc: (s: Settings) => string;
  chainDef: (rpc: string) => ReturnType<typeof defineChain>;
}

const chainDef = (id: number, name: string, symbol: string, currency: string) => (rpc: string) =>
  defineChain({ id, name, nativeCurrency: { name: currency, symbol, decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

const cluster = keeperCluster();

export const NETS: EvmNet[] = [
  { chain: "ethereum", name: cluster.ethereum.label, unit: "ETH", rpc: (s) => s.hoodiRpc, chainDef: chainDef(cluster.ethereum.chainId, cluster.ethereum.label, "ETH", "Ether") },
  { chain: "hyperEvm", name: cluster.hyperevm.label, unit: "HYPE", rpc: (s) => s.hyperEvmRpc, chainDef: chainDef(cluster.hyperevm.chainId, cluster.hyperevm.label, "HYPE", "HYPE") },
];
