import { defineChain } from "viem";
import { hoodi as viemHoodi, mainnet as viemMainnet } from "viem/chains";
import { CLUSTER } from "./cluster-settings";

/** The RPCs the app reads and waits on; Privy's chains below use the same ones so a transaction is sent and confirmed through one node. */
const TEST = CLUSTER.id === "test";

/** Next inlines NEXT_PUBLIC_ variables only when they are written out in full, so each is spelled out. Mainnet has no default: an unset RPC throws. */
function rpcFor(name: string, value: string | undefined, testDefault: string): string {
  if (value) return value;
  if (TEST) return testDefault;
  throw new Error(`${name} is not set; mainnet has no default RPC`);
}

/** The active cluster's Ethereum and HyperEVM RPCs (Hoodi and HyperEVM testnet in test mode). */
export const HOODI_RPC = TEST
  ? rpcFor(CLUSTER.ethereum.rpcEnv, process.env.NEXT_PUBLIC_HOODI_RPC, "https://ethereum-hoodi-rpc.publicnode.com")
  : rpcFor(CLUSTER.ethereum.rpcEnv, process.env.NEXT_PUBLIC_ETHEREUM_RPC, "");
export const HYPEREVM_RPC = rpcFor(CLUSTER.hyperevm.rpcEnv, process.env.NEXT_PUBLIC_HYPEREVM_RPC, "https://rpc.hyperliquid-testnet.xyz/evm");

export const hoodi = defineChain({ ...(TEST ? viemHoodi : viemMainnet), rpcUrls: { default: { http: [HOODI_RPC] } } });

/** HyperEVM (testnet in test mode, mainnet on mainnet). Defined here so the RPC is pinned to the one in the build brief. */
export const hyperEvmTestnet = defineChain({
  id: CLUSTER.hyperevm.chainId,
  name: TEST ? "HyperEVM Testnet" : "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [HYPEREVM_RPC] } },
  testnet: TEST,
});

/** EVM networks the Account's EVM address is used on. Hoodi is the default. */
export const EVM_CHAINS = [hoodi, hyperEvmTestnet] as const;

export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_DEVNET_WS = "wss://api.devnet.solana.com";
