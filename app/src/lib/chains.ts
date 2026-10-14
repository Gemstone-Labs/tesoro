import { defineChain } from "viem";
import { hoodi as viemHoodi } from "viem/chains";

/** The RPCs the app reads and waits on; Privy's chains below use the same ones so a transaction is sent and confirmed through one node. */
export const HOODI_RPC = process.env.NEXT_PUBLIC_HOODI_RPC ?? "https://ethereum-hoodi-rpc.publicnode.com";
export const HYPEREVM_RPC = process.env.NEXT_PUBLIC_HYPEREVM_RPC ?? "https://rpc.hyperliquid-testnet.xyz/evm";

export const hoodi = defineChain({ ...viemHoodi, rpcUrls: { default: { http: [HOODI_RPC] } } });

/** HyperEVM testnet (chain id 998). Defined here so the RPC is pinned to the one in the build brief. */
export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [HYPEREVM_RPC] } },
  testnet: true,
});

/** EVM networks the Account's EVM address is used on. Hoodi is the default. */
export const EVM_CHAINS = [hoodi, hyperEvmTestnet] as const;

export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_DEVNET_WS = "wss://api.devnet.solana.com";
