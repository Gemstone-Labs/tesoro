import type { Account, Address, Chain, WalletClient } from "viem";
import type { ChainSigner } from "@/games/block-puzzle/chain";

/** A wallet the person linked themselves, as opposed to the embedded wallets Tesoro creates for the Account. */
export interface LinkedWallet {
  family: "solana" | "evm";
  address: string;
  /** Wallet app name as Privy reports it, e.g. "phantom", "metamask". */
  client: string;
}

/** The Account's EVM wallet (the embedded one, or a linked external wallet when there is none), as a viem client (Hoodi by default; `clientFor` for HyperEVM). */
export interface EvmSigner {
  address: Address;
  /** Signs `personal_sign` and sends transactions with `account` set to `address`. */
  client: WalletClient;
  /** The local account (dev key) or the address of a JSON-RPC wallet; pass it as `account` on every call. */
  account: Account | Address;
  /** The same wallet as a client on `chain`, for transactions there. */
  clientFor: (chain: Chain) => WalletClient;
  /** Switches the wallet to `chain` (default Hoodi) before a transaction (a no-op for the dev key). */
  prepare: (chain?: Chain) => Promise<void>;
  source: "embedded" | "linked" | "dev";
}

export type AuthStatus = "unconfigured" | "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  email: string | null;
  /** The Account's wallet addresses (the embedded ones Privy creates for every sign-in method); null until they exist (a moment after first sign-in). */
  addresses: { solana: string | null; evm: string | null };
  linked: LinkedWallet[];
  signOut: () => Promise<void>;
  linkWallet: (family: "solana" | "evm") => void;
  /**
   * Run `action` now if signed in; otherwise open the sign-in sheet and run it once sign-in succeeds.
   * `reason` completes the sentence "Sign in to ...".
   */
  gate: (reason: string, action: () => void) => void;
  openSignIn: (reason?: string) => void;
  openAccount: () => void;
  /** Signs Solana transactions and messages with the Account's embedded wallet; null until it exists. */
  signer: ChainSigner | null;
  /** Signs and sends on Hoodi with the Account's EVM wallet; null until it exists. */
  evm: EvmSigner | null;
  /** The person's own Solana wallet when one is linked and connected (Phantom, Solflare, ...). It proves a .sol name by co-signing; it never signs game moves. Null in dev mode. */
  externalSolana: ChainSigner | null;
  /** The person's own Ethereum wallet when one is linked and connected (MetaMask, Rabby, ...). It proves a .eth or .hl name; null in dev mode. */
  externalEvm: EvmSigner | null;
  /** Privy access token for server routes (null when signed out or in dev-wallet mode). */
  getAccessToken: () => Promise<string | null>;
  /** True when the dev-only local Keypair wallet stands in for Privy (never in production builds). */
  devWallet: boolean;
}
