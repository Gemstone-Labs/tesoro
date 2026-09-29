"use client";

import { useState } from "react";
import { Button, ChainChip, CheckIcon, CopyIcon, Label, Sheet } from "@/components/ui";
import { useAuth } from "@/lib/auth/context";
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
  const { email, addresses, linked, linkWallet, signOut } = useAuth();
  const solanaLinked = linked.filter((w) => w.family === "solana");
  const evmLinked = linked.filter((w) => w.family === "evm");
  return (
    <Sheet open={open} onClose={onClose} title="Account">
      <div className="stack">
        <span className="meta">{email ?? "Signed in"}</span>
        <AddressCard title="Solana address" chains={["SOL"]} address={addresses.solana} />
        <AddressCard title="EVM address" chains={["ETH", "HYPE"]} address={addresses.evm} />
        <p className="note">One EVM address works on Ethereum Hoodi and HyperEVM testnet. Testnets only.</p>
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
          <Button size="sm" onClick={() => linkWallet("evm")}>Link EVM wallet</Button>
        </div>
        <p className="note">Phantom or Backpack for Solana, MetaMask for EVM. Your Account, not the wallet, holds Positions and Gemas.</p>
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
