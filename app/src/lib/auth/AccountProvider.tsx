"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PrivyProvider, useCreateWallet, useLogin, usePrivy, useWallets, type ConnectedWallet, type PrivyClientConfig } from "@privy-io/react-auth";
import { createWalletClient, custom, type Address } from "viem";
import {
  toSolanaWalletConnectors,
  useCreateWallet as useCreateSolanaWallet,
  useSignMessage,
  useSignTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { AccountSheet } from "@/components/shell/AccountSheet";
import { SignInSheet } from "@/components/shell/SignInSheet";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { DEV_WALLET } from "@/lib/chain/config";
import { EVM_CHAINS, SOLANA_DEVNET_RPC, SOLANA_DEVNET_WS, hoodi } from "@/lib/chains";
import { AuthContext, UNCONFIGURED } from "./context";
import type { AuthState, EvmSigner, LinkedWallet } from "./types";

// Dev-only signer. The condition is a build-time constant, so production builds drop the import entirely.
const DevAccountProvider = DEV_WALLET ? lazy(() => import("./DevAccountProvider").then((m) => ({ default: m.DevAccountProvider }))) : null;

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const privyConfig: PrivyClientConfig = {
  // Email, or a Solana / Ethereum wallet. Either way the Account is backed by the embedded wallets below:
  // a wallet used to sign in is linked to it and proves who the person is, but never signs game moves.
  loginMethods: ["email", "wallet"],
  appearance: {
    theme: "dark",
    accentColor: "#EAEFEC",
    walletChainType: "ethereum-and-solana",
    // Installed wallets first (Phantom, Solflare, Backpack, MetaMask, Rabby, ...), then the QR options.
    walletList: ["detected_solana_wallets", "detected_ethereum_wallets", "phantom", "metamask", "coinbase_wallet", "wallet_connect"],
  },
  // Every Account gets one embedded wallet per chain family.
  embeddedWallets: {
    // Match moves are signed in the background; no confirmation modal per transaction.
    showWalletUIs: false,
    ethereum: { createOnLogin: "all-users" },
    solana: { createOnLogin: "all-users" },
  },
  // Phantom / Solflare / Backpack via wallet-standard.
  externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
  // Hoodi and HyperEVM testnet. The same EVM address is valid on both.
  supportedChains: [...EVM_CHAINS],
  defaultChain: hoodi,
  solana: {
    rpcs: {
      "solana:devnet": {
        rpc: createSolanaRpc(SOLANA_DEVNET_RPC),
        rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_DEVNET_WS),
      },
    },
  },
};

/** The embedded wallet signs without a prompt, in about a second; one that has not answered in 60 s is not going to. */
function signingTimeout<T>(p: Promise<T>, ms = 60_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Your wallet did not answer the signing request. Reload the page and try again.")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

function evmSignerOf(wallet: ConnectedWallet, source: EvmSigner["source"]): EvmSigner {
  const address = wallet.address as Address;
  const transport = custom({
    request: async (args: { method: string; params?: unknown }) => {
      const provider = await wallet.getEthereumProvider();
      return provider.request(args as Parameters<typeof provider.request>[0]);
    },
  });
  return {
    address,
    account: address,
    client: createWalletClient({ account: address, chain: hoodi, transport }),
    clientFor: (chain) => createWalletClient({ account: address, chain, transport }),
    prepare: async (chain = hoodi) => {
      await wallet.switchChain(chain.id);
    },
    source,
  };
}

export function AccountProvider({ children }: { children: ReactNode }) {
  if (DevAccountProvider) {
    return (
      <Suspense fallback={null}>
        <DevAccountProvider>{children}</DevAccountProvider>
      </Suspense>
    );
  }
  if (!PRIVY_APP_ID) return <AuthContext.Provider value={UNCONFIGURED}>{children}</AuthContext.Provider>;
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, logout, linkWallet, getAccessToken } = usePrivy();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { wallets: evmWallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { createWallet: createEvmWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();

  const [signInOpen, setSignInOpen] = useState(false);
  const [reason, setReason] = useState<string | undefined>();
  const [accountOpen, setAccountOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const walletLogin = useRef(false);

  const finishSignIn = useCallback(() => {
    setSignInOpen(false);
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);

  const { login } = useLogin({
    onComplete: () => {
      if (!walletLogin.current) return;
      walletLogin.current = false;
      finishSignIn();
    },
    onError: () => {
      walletLogin.current = false;
    },
  });

  /** Privy's wallet picker is its own modal and would sit under our dialog: close ours first, keeping what the person was doing. */
  const signInWithWallet = useCallback(
    (family: "solana" | "evm") => {
      walletLogin.current = true;
      setSignInOpen(false);
      login({ loginMethods: ["wallet"], walletChainType: family === "solana" ? "solana-only" : "ethereum-only" });
    },
    [login],
  );

  const wallets = useMemo(
    () => (user?.linkedAccounts ?? []).flatMap((a) => (a.type === "wallet" ? [a] : [])),
    [user],
  );
  const isEmbedded = (client?: string) => client === "privy" || client === "privy-v2";
  const solana = wallets.find((w) => w.chainType === "solana" && isEmbedded(w.walletClientType))?.address ?? null;
  const evm = wallets.find((w) => w.chainType === "ethereum" && isEmbedded(w.walletClientType))?.address ?? null;
  const linked: LinkedWallet[] = wallets
    .filter((w) => !isEmbedded(w.walletClientType))
    .flatMap((w) =>
      w.chainType === "solana" || w.chainType === "ethereum"
        ? [{ family: w.chainType === "solana" ? ("solana" as const) : ("evm" as const), address: w.address, client: w.walletClientType ?? "wallet" }]
        : [],
    );

  // createOnLogin covers new sign-ins; this covers Accounts created before a chain family was enabled.
  const ensured = useRef({ solana: false, evm: false });
  useEffect(() => {
    if (!ready || !authenticated || !user) return;
    if (!evm && !ensured.current.evm) {
      ensured.current.evm = true;
      createEvmWallet().catch(() => (ensured.current.evm = false));
    }
    if (!solana && !ensured.current.solana) {
      ensured.current.solana = true;
      createSolanaWallet().catch(() => (ensured.current.solana = false));
    }
  }, [ready, authenticated, user, evm, solana, createEvmWallet, createSolanaWallet]);

  const signer = useMemo<ChainSigner | null>(() => {
    const wallet = solana ? solanaWallets.find((w) => w.address === solana) : undefined;
    if (!wallet || !solana) return null;
    const uiOptions = { showWalletUIs: false };
    return {
      publicKey: new PublicKey(solana),
      signTransaction: async (tx: Transaction) => {
        const { signedTransaction } = await signingTimeout(
          signTransaction({
            transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
            wallet,
            chain: "solana:devnet",
            options: { uiOptions },
          }),
        );
        return Transaction.from(signedTransaction);
      },
      signMessage: async (message: Uint8Array) => (await signingTimeout(signMessage({ message, wallet, options: { uiOptions } }))).signature,
    };
  }, [solana, solanaWallets, signTransaction, signMessage]);

  // The embedded EVM wallet signs on Hoodi; a linked external EVM wallet stands in when there is none.
  const evmSigner = useMemo<EvmSigner | null>(() => {
    const embedded = evm ? evmWallets.find((w) => w.address.toLowerCase() === evm.toLowerCase()) : undefined;
    const external = linked.find((l) => l.family === "evm");
    const wallet = embedded ?? (external ? evmWallets.find((w) => w.address.toLowerCase() === external.address.toLowerCase()) : undefined);
    return wallet ? evmSignerOf(wallet, embedded ? "embedded" : "linked") : null;
    // `linked` is rebuilt every render from `wallets`; depend on its source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evm, evmWallets, wallets]);

  // The person's own Ethereum wallet (MetaMask, Rabby, ...), when connected: it proves a .eth or .hl name, and never signs game moves.
  const externalEvm = useMemo<EvmSigner | null>(() => {
    const external = linked.find((l) => l.family === "evm");
    const wallet = external ? evmWallets.find((w) => w.address.toLowerCase() === external.address.toLowerCase()) : undefined;
    return wallet ? evmSignerOf(wallet, "linked") : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmWallets, wallets]);

  // The person's own Solana wallet (Phantom, Solflare, Backpack), when connected: it co-signs to show its .sol name.
  const externalSolana = useMemo<ChainSigner | null>(() => {
    const external = linked.find((l) => l.family === "solana");
    const wallet = external ? solanaWallets.find((w) => w.address === external.address) : undefined;
    if (!wallet || !external) return null;
    return {
      publicKey: new PublicKey(external.address),
      // The wallet app asks the person to approve: this is only used for the rare identity steps.
      signTransaction: async (tx: Transaction) => {
        const { signedTransaction } = await signingTimeout(
          signTransaction({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), wallet, chain: "solana:devnet" }),
          180_000,
        );
        return Transaction.from(signedTransaction);
      },
      signMessage: async (message: Uint8Array) => (await signingTimeout(signMessage({ message, wallet }), 180_000)).signature,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solanaWallets, wallets, signTransaction, signMessage]);

  const gate = useCallback(
    (why: string, action: () => void) => {
      if (authenticated) return action();
      pending.current = action;
      setReason(why);
      setSignInOpen(true);
    },
    [authenticated],
  );

  const value = useMemo<AuthState>(
    () => ({
      status: !ready ? "loading" : authenticated ? "signed-in" : "signed-out",
      email: user?.email?.address ?? null,
      addresses: { solana, evm },
      linked,
      signOut: logout,
      linkWallet: (family) => linkWallet({ walletChainType: family === "solana" ? "solana-only" : "ethereum-only" }),
      gate,
      openSignIn: (why) => {
        pending.current = null;
        setReason(why);
        setSignInOpen(true);
      },
      openAccount: () => setAccountOpen(true),
      signer,
      evm: evmSigner,
      externalSolana,
      externalEvm,
      getAccessToken,
      devWallet: false,
    }),
    // `linked` is rebuilt every render from `wallets`; depend on its source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, authenticated, user, solana, evm, wallets, logout, linkWallet, gate, signer, evmSigner, externalSolana, externalEvm, getAccessToken],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SignInSheet
        open={signInOpen}
        reason={reason}
        onClose={() => {
          pending.current = null;
          setSignInOpen(false);
        }}
        onSignedIn={finishSignIn}
        onWallet={signInWithWallet}
      />
      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onSignedOut={() => setAccountOpen(false)}
      />
    </AuthContext.Provider>
  );
}
