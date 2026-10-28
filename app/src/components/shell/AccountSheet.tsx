"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, LogOut, Plus } from "lucide-react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { ChainGlyph, Sheet } from "@/components/ui";
import { art } from "@/lib/art";
import { useAuth } from "@/lib/auth/context";
import type { LinkedWallet } from "@/lib/auth/types";
import { accountKeyOf } from "@/lib/chain/account-key";
import { getChain } from "@/lib/chain/client";
import { fetchLinkState } from "@/lib/chain/eth";
import "./account-sheet.css";

/** The Account's details: who is signed in, the addresses Tesoro made for it, the wallets linked to it, Sign out. */
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
  // The Account key, which every screen shows this Player by (the sheet sits outside ChainDataProvider).
  const me = useMemo(() => (addresses.solana ? accountKeyOf(addresses.solana) : null), [addresses.solana]);
  const wallets = [...linked.filter((w) => w.family === "solana"), ...linked.filter((w) => w.family === "evm")];

  return (
    <Sheet open={open} onClose={onClose} title="Account">
      <div className="cut cut-card as-card">
        <Image className="as-banner" src={art.profileBanner} alt="" width={960} height={400} />
        <div className="as-who">
          <span className="cut cut-btn as-avatar">{me && <PlayerAvatar account={me} size={64} />}</span>
          <div className="as-name">
            <strong>{me ? <PlayerName account={me} /> : "Your Account"}</strong>
            <span className="meta">{email ?? (linked[0] ? `Signed in with ${walletName(linked[0])}` : "Signed in")}</span>
          </div>
        </div>
      </div>

      <section className="as-sec">
        <h3 className="label">Your addresses</h3>
        <div className="cut cut-card as-list">
          <AddressRow chains={[0]} title="Solana" address={addresses.solana} />
          <AddressRow
            chains={[1, 2]}
            title="ETH & HYPE"
            address={evm?.address ?? addresses.evm}
            note={link === "linked" ? "Linked: ETH and HYPE payouts go here" : link === "unlinked" ? "Links with one signature on your first ETH or HYPE Lock" : undefined}
          />
        </div>
      </section>

      <section className="as-sec">
        <h3 className="label">Linked wallets</h3>
        <div className="cut cut-card as-list">
          {wallets.map((w) => (
            <AddressRow key={`${w.family}-${w.address}`} chains={[w.family === "solana" ? 0 : 1]} title={walletName(w)} address={w.address} />
          ))}
          <div className="as-add">
            <button type="button" className="cut cut-btn" onClick={() => linkWallet("solana")}>
              <Plus aria-hidden="true" /> Solana wallet
            </button>
            <button type="button" className="cut cut-btn" onClick={() => linkWallet("evm")}>
              <Plus aria-hidden="true" /> Ethereum wallet
            </button>
          </div>
        </div>
      </section>

      <div className="as-foot">
        <button
          type="button"
          className="as-out"
          onClick={async () => {
            await signOut();
            onSignedOut();
          }}
        >
          <LogOut aria-hidden="true" /> Sign out
        </button>
      </div>
    </Sheet>
  );
}

const walletName = (w: LinkedWallet) => w.client.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const short = (a: string) => `${a.slice(0, a.startsWith("0x") ? 7 : 5)}…${a.slice(-5)}`;

/** One address as a row: the whole row copies it. */
function AddressRow({ chains, title, address, note }: { chains: (0 | 1 | 2)[]; title: string; address: string | null; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="as-row"
      disabled={!address}
      title={address ?? undefined}
      aria-label={address ? `${copied ? "Copied" : "Copy"} ${title} address ${address}` : `${title}: creating your wallet`}
      onClick={async () => {
        if (!address) return;
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span className="as-chains">
        {chains.map((c) => (
          <ChainGlyph key={c} asset={c} size={20} />
        ))}
      </span>
      <span className="as-text">
        <strong>{title}</strong>
        {note && <small>{note}</small>}
      </span>
      <code>{address ? short(address) : "Creating…"}</code>
      <span className={`as-copy${copied ? " done" : ""}`} aria-hidden="true">
        {copied ? <Check /> : <Copy />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </span>
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
