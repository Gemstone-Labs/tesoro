/** A wallet the person linked themselves, as opposed to the embedded wallets Tesoro creates for the Account. */
export interface LinkedWallet {
  family: "solana" | "evm";
  address: string;
  /** Wallet app name as Privy reports it, e.g. "phantom", "metamask". */
  client: string;
}

export type AuthStatus = "unconfigured" | "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  email: string | null;
  /** Embedded wallet addresses; null until Privy has created them (a moment after first sign-in). */
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
}
