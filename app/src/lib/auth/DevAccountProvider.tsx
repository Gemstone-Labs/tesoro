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
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hoodi } from "viem/chains";
import { HOODI_RPC } from "@/lib/chain/eth";
import { AuthContext } from "./context";
import type { AuthState, EvmSigner } from "./types";

const KEY = (slot: string) => `tesoro-dev-wallet:${slot}`;
const EVM_KEY = (slot: string) => `tesoro-dev-evm:${slot}`;

/** The dev EVM key, kept beside the Solana one. Same rules: local, never with anything of value. */
function loadEvm(slot: string): `0x${string}` {
  try {
    const raw = localStorage.getItem(EVM_KEY(slot));
    if (raw && /^0x[0-9a-f]{64}$/.test(raw)) return raw as `0x${string}`;
  } catch {
    // fall through to a fresh key
  }
  const k = generatePrivateKey();
  try {
    localStorage.setItem(EVM_KEY(slot), k);
  } catch {
    // private mode: the key lives for this page load only
  }
  return k;
}

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
  const [evmKey, setEvmKey] = useState<`0x${string}` | null>(null);
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
      // `?dev=out` previews the signed-out UI.
      if (s === "out") return;
      setKeypair(load(s));
      setEvmKey(loadEvm(s));
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
    const evm: EvmSigner | null = evmKey && {
      address: privateKeyToAccount(evmKey).address,
      account: privateKeyToAccount(evmKey),
      client: createWalletClient({ account: privateKeyToAccount(evmKey), chain: hoodi, transport: http(HOODI_RPC) }),
      // The dev key signs locally and sends through the chain's own RPC.
      clientFor: (chain) => createWalletClient({ account: privateKeyToAccount(evmKey), chain, transport: http(chain.id === hoodi.id ? HOODI_RPC : undefined) }),
      prepare: async () => {},
      source: "dev",
    };
    return {
      status: slot === "out" ? "signed-out" : keypair ? "signed-in" : "loading",
      email: `dev-${slot}@local`,
      addresses: { solana: keypair?.publicKey.toBase58() ?? null, evm: evm?.address ?? null },
      linked: [],
      signOut: async () => {
        try {
          localStorage.removeItem(KEY(slot));
          localStorage.removeItem(EVM_KEY(slot));
        } catch {
          // ignore
        }
        setKeypair(load(slot));
        setEvmKey(loadEvm(slot));
      },
      linkWallet: () => {},
      gate: (_reason, action) => {
        if (slot !== "out") action();
      },
      openSignIn: () => {},
      openAccount: () => setAccountOpen(true),
      signer,
      evm,
      getAccessToken: async () => null,
      devWallet: true,
    };
  }, [keypair, evmKey, slot]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} onSignedOut={() => setAccountOpen(false)} />
    </AuthContext.Provider>
  );
}
