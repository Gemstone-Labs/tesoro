import { defineChain } from "viem";
import { hoodi } from "viem/chains";

export { hoodi };

/** HyperEVM testnet (chain id 998). Defined here so the RPC is pinned to the one in docs/BUILD.md. */
export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] } },
  testnet: true,
});

/** EVM networks the Account's EVM address is used on. Hoodi is the default. */
export const EVM_CHAINS = [hoodi, hyperEvmTestnet] as const;

export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_DEVNET_WS = "wss://api.devnet.solana.com";
