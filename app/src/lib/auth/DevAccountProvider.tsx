"use client";

/**
 * DEV ONLY. Stands in for Privy when NEXT_PUBLIC_DEV_WALLET=1 and NODE_ENV !== "production"
 * (see lib/chain/config.ts), so the on-chain flow can be driven without an email inbox.
 * Each browser tab context holds a local Keypair in localStorage; `?dev=<name>` picks a named one.
 * The key lives in the browser: never point this at anything with value.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Keypair, type Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { AccountSheet } from "@/components/shell/AccountSheet";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { AuthContext } from "./context";
import type { AuthState } from "./types";

const KEY = (slot: string) => `tesoro-dev-wallet:${slot}`;

function load(slot: string): Keypair {
  try {
    const raw = localStorage.getItem(KEY(slot));
    if (raw) return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    // fall through to a fresh key
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(KEY(slot), bs58.encode(kp.secretKey));
  } catch {
    // private mode: the key lives for this page load only
  }
  return kp;
}

/** Refuses to render in production builds even if it were ever imported there. */
export function DevAccountProvider({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") return null;
  return <DevBridge>{children}</DevBridge>;
}

function DevBridge({ children }: { children: ReactNode }) {
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [slot, setSlot] = useState("1");
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("dev");
    let s = fromUrl ?? "1";
    try {
      if (fromUrl) sessionStorage.setItem("tesoro-dev-slot", fromUrl);
      else s = sessionStorage.getItem("tesoro-dev-slot") ?? "1";
    } catch {
      // ignore
    }
    // Deferred: the key comes from localStorage, which the server render cannot see.
    const t = setTimeout(() => {
      setSlot(s);
      setKeypair(load(s));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const value = useMemo<AuthState>(() => {
    const signer: ChainSigner | null = keypair && {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(keypair);
        return tx;
      },
      signMessage: async (m) => nacl.sign.detached(m, keypair.secretKey),
    };
    return {
      status: keypair ? "signed-in" : "loading",
      email: `dev-${slot}@local`,
      addresses: { solana: keypair?.publicKey.toBase58() ?? null, evm: null },
      linked: [],
      signOut: async () => {
        try {
          localStorage.removeItem(KEY(slot));
        } catch {
          // ignore
        }
        setKeypair(load(slot));
      },
      linkWallet: () => {},
      gate: (_reason, action) => action(),
      openSignIn: () => {},
      openAccount: () => setAccountOpen(true),
      signer,
      getAccessToken: async () => null,
      devWallet: true,
    };
  }, [keypair, slot]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} onSignedOut={() => setAccountOpen(false)} />
    </AuthContext.Provider>
  );
}
