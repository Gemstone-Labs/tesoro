"use client";

import { createContext, useContext } from "react";
import type { AuthState } from "./types";

export const UNCONFIGURED: AuthState = {
  status: "unconfigured",
  email: null,
  addresses: { solana: null, evm: null },
  linked: [],
  signOut: async () => {},
  linkWallet: () => {},
  // Without a Privy app id there is no Account to sign in to; let the action through so the demo stays usable.
  gate: (_reason, action) => action(),
  openSignIn: () => {},
  openAccount: () => {},
};

export const AuthContext = createContext<AuthState>(UNCONFIGURED);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
