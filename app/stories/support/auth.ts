import { UNCONFIGURED } from "@/lib/auth/context";
import type { AuthState } from "@/lib/auth/types";
import { DEMO_EVM, DEMO_ME, type AuthMode } from "./data";

const noop = () => {};

/** A signed-in Account with no wallets to sign with: every read works, any transaction is a no-op. */
export const SIGNED_IN: AuthState = {
  ...UNCONFIGURED,
  status: "signed-in",
  email: "ana@example.com",
  addresses: { solana: DEMO_ME, evm: DEMO_EVM },
  linked: [{ family: "solana", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", client: "phantom" }],
  gate: (_reason, action) => action(),
  openSignIn: noop,
  openAccount: noop,
};

export const SIGNED_OUT: AuthState = { ...UNCONFIGURED, status: "signed-out", gate: noop };
export const LOADING: AuthState = { ...UNCONFIGURED, status: "loading", gate: noop };

export function authFor(mode: AuthMode): AuthState {
  return mode === "signed-out" ? SIGNED_OUT : mode === "loading" ? LOADING : SIGNED_IN;
}
