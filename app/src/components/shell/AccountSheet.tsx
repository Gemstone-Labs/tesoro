"use client";

import { useEffect, useState } from "react";
import { Button, ChainChip, CheckIcon, CopyIcon, Label, Sheet } from "@/components/ui";
import { useAuth } from "@/lib/auth/context";
import { getChain } from "@/lib/chain/client";
import { fetchLinkState } from "@/lib/chain/eth";
import type { Chain } from "@/lib/mock";

export function AccountSheet({
  open,
  onClose,
  onSignedOut,
}: {
  open: boolean;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const { email, addresses, linked, linkWallet, signOut, evm, signer } = useAuth();
  const link = useEvmLink(open, signer?.publicKey.toBase58() ?? null, evm?.address ?? null);
  const solanaLinked = linked.filter((w) => w.family === "solana");
  const evmLinked = linked.filter((w) => w.family === "evm");
  return (
    <Sheet open={open} onClose={onClose} title="Account">
      <div className="stack">
        <span className="meta">{email ?? (linked[0] ? `Signed in with ${linked[0].client.replace(/_/g, " ")}` : "Signed in")}</span>
        <AddressCard title="Solana address" chains={["SOL"]} address={addresses.solana} />
        <AddressCard title="ETH & HYPE address" chains={["ETH", "HYPE"]} address={evm?.address ?? addresses.evm} />
        {evm && (
          <p className="meta">
            {link === "linked"
              ? "Linked to your Account: ETH and HYPE Positions and payouts use this address."
              : link === "unlinked"
                ? "Not linked yet. It links (one signature) the first time you open an ETH or HYPE Position."
                : "Checking link…"}
          </p>
        )}
        <p className="note">The same address works for ETH and HYPE. Test mode.</p>
      </div>

      <div className="stack">
        <Label>Linked wallets</Label>
        {linked.length === 0 && <p className="meta">No external wallets linked.</p>}
        {[...solanaLinked, ...evmLinked].map((w) => (
          <div key={`${w.family}-${w.address}`} className="addr">
            <div className="addr-line">
              <span className="hstack">
                <ChainChip chain={w.family === "solana" ? "SOL" : "ETH"} />
                <strong style={{ textTransform: "capitalize" }}>{w.client.replace(/_/g, " ")}</strong>
              </span>
              <CopyButton value={w.address} label={`Copy ${w.client} address`} />
            </div>
            <code>{w.address}</code>
          </div>
        ))}
        <div className="hstack wrap">
          <Button size="sm" onClick={() => linkWallet("solana")}>Link Solana wallet</Button>
          <Button size="sm" onClick={() => linkWallet("evm")}>Link ETH wallet</Button>
        </div>
        <p className="note">Phantom, Solflare or Backpack for Solana; MetaMask or Rabby for ETH and HYPE. Your Account, not the wallet, holds Positions and Gemas. A linked wallet can show its .sol, .eth or .hl name on your profile.</p>
      </div>

      <Button
        block
        onClick={async () => {
          await signOut();
          onSignedOut();
        }}
      >
        Sign out
      </Button>
    </Sheet>
  );
}

function AddressCard({ title, chains, address }: { title: string; chains: Chain[]; address: string | null }) {
  return (
    <div className="addr">
      <div className="addr-line">
        <span className="hstack">
          {chains.map((c) => (
            <ChainChip key={c} chain={c} />
          ))}
          <strong>{title}</strong>
        </span>
        {address && <CopyButton value={address} label={`Copy ${title}`} />}
      </div>
      {address ? <code>{address}</code> : <span className="meta">Creating your wallet…</span>}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cut cut-chip icon-btn"
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** Whether the EVM address is proven to the bridge (an `EvmLink` for this Account exists). */
function useEvmLink(open: boolean, solana: string | null, evm: string | null): "linked" | "unlinked" | "unknown" {
  const [state, setState] = useState<{ key: string; value: "linked" | "unlinked" } | null>(null);
  const key = `${solana}:${evm}`;
  useEffect(() => {
    if (!open || !solana || !evm) return;
    let live = true;
    void import("@solana/web3.js").then(({ PublicKey }) =>
      fetchLinkState(getChain().base, new PublicKey(solana), evm)
        .then((s) => live && setState({ key, value: s.linked && s.addressSet ? "linked" : "unlinked" }))
        .catch(() => undefined),
    );
    return () => {
      live = false;
    };
  }, [open, solana, evm, key]);
  return state?.key === key ? state.value : "unknown";
}
