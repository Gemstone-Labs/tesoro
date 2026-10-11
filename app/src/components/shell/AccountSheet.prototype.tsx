"use client";

/**
 * PROTOTYPE ONLY: four takes on the Account sheet, switched with ?variant=now|A|B|C|D.
 * A ID card · B Address focus · C Account map · D Settings list. The winner gets rewritten into AccountSheet.tsx.
 */
import Image from "next/image";
import { useState } from "react";
import { Check, ChevronRight, Copy, LogOut, Plus } from "lucide-react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { AssetPicker, ChainGlyph } from "@/components/ui";
import { art } from "@/lib/art";
import type { AuthState, LinkedWallet } from "@/lib/auth/types";
import "./account-sheet.prototype.css";

export const SHEET_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "ID card" },
  { key: "B", name: "Address focus" },
  { key: "C", name: "Account map" },
  { key: "D", name: "Settings list" },
] as const;
export type SheetVariant = (typeof SHEET_VARIANTS)[number]["key"];

export type SheetData = {
  auth: AuthState;
  me: string | null;
  evmAddress: string | null;
  link: "linked" | "unlinked" | "unknown";
  onSignOut: () => void;
};

const short = (a: string, n = 4) => (a.length <= n * 2 + 1 ? a : `${a.slice(0, a.startsWith("0x") ? n + 2 : n)}…${a.slice(-n)}`);
const walletName = (w: LinkedWallet) => w.client.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const signedInWith = (auth: AuthState) =>
  auth.email ?? (auth.linked[0] ? `Signed in with ${walletName(auth.linked[0])}` : "Signed in");
const glyph = (family: LinkedWallet["family"]) => (family === "solana" ? 0 : 1) as 0 | 1;

function useCopy(): [string | null, (value: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [
    copied,
    (value) => {
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(value);
          setTimeout(() => setCopied((c) => (c === value ? null : c)), 1600);
        },
        () => undefined,
      );
    },
  ];
}

function linkLine(link: SheetData["link"]) {
  return link === "linked" ? "Linked: ETH and HYPE payouts go here" : link === "unlinked" ? "Links with one signature on your first ETH or HYPE Position" : null;
}

export function AccountSheetPrototype({ variant, data }: { variant: Exclude<SheetVariant, "now">; data: SheetData }) {
  if (variant === "A") return <IdCard {...data} />;
  if (variant === "B") return <AddressFocus {...data} />;
  if (variant === "C") return <AccountMap {...data} />;
  return <SettingsList {...data} />;
}

/* ——— A · ID card: who you are on a banner card, addresses as tap-to-copy rows, the long note folded away ——— */

function IdCard({ auth, me, evmAddress, link, onSignOut }: SheetData) {
  const [copied, copy] = useCopy();
  const sol = auth.addresses.solana;
  return (
    <div className="asx-a">
      <div className="cut cut-card asx-a-card">
        <Image className="asx-a-banner" src={art.profileBanner} alt="" width={960} height={400} />
        <div className="asx-a-who">
          <span className="cut cut-btn asx-a-avatar">{me && <PlayerAvatar account={me} size={64} />}</span>
          <div className="asx-a-name">
            <strong>{me ? <PlayerName account={me} /> : "Your Account"}</strong>
            <span className="meta">{signedInWith(auth)}</span>
          </div>
        </div>
      </div>

      <section className="asx-a-sec">
        <h3 className="label">Your addresses</h3>
        <div className="cut cut-card asx-a-list">
          <AddrRow glyphs={[0]} title="Solana" address={sol} copied={copied} copy={copy} />
          <AddrRow glyphs={[1, 2]} title="ETH & HYPE" address={evmAddress} copied={copied} copy={copy} sub={linkLine(link) ?? "One address on Ethereum and HyperEVM"} />
        </div>
      </section>

      <section className="asx-a-sec">
        <h3 className="label">Linked wallets</h3>
        <div className="cut cut-card asx-a-list">
          {auth.linked.map((w) => (
            <AddrRow key={`${w.family}-${w.address}`} glyphs={[glyph(w.family)]} title={walletName(w)} address={w.address} copied={copied} copy={copy} />
          ))}
          <div className="asx-a-add">
            <button type="button" className="cut cut-btn" onClick={() => auth.linkWallet("solana")}>
              <Plus aria-hidden="true" /> Solana wallet
            </button>
            <button type="button" className="cut cut-btn" onClick={() => auth.linkWallet("evm")}>
              <Plus aria-hidden="true" /> Ethereum wallet
            </button>
          </div>
        </div>
        <details className="asx-a-why">
          <summary>What does linking a wallet do?</summary>
          <p>
            It shows your .sol, .eth or .hl name on your profile. Your Account, not the wallet, holds your Positions and Gemas. Phantom, Solflare or
            Backpack for Solana; MetaMask or Rabby for ETH and HYPE.
          </p>
        </details>
      </section>

      <div className="asx-a-foot">
        <span className="meta">Test mode</span>
        <button type="button" className="asx-quiet" onClick={onSignOut}>
          <LogOut aria-hidden="true" /> Sign out
        </button>
      </div>
    </div>
  );
}

function AddrRow({
  glyphs,
  title,
  address,
  sub,
  copied,
  copy,
}: {
  glyphs: (0 | 1 | 2)[];
  title: string;
  address: string | null;
  sub?: string;
  copied: string | null;
  copy: (v: string) => void;
}) {
  const done = address !== null && copied === address;
  return (
    <button type="button" className="asx-a-row" disabled={!address} onClick={() => address && copy(address)} title={address ?? undefined}>
      <span className="asx-glyphs">
        {glyphs.map((g) => (
          <ChainGlyph key={g} asset={g} size={20} />
        ))}
      </span>
      <span className="asx-a-text">
        <strong>{title}</strong>
        {sub && <small>{sub}</small>}
      </span>
      <code>{address ? short(address, 5) : "Creating…"}</code>
      <span className={`asx-a-copy${done ? " done" : ""}`}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{done ? "Copied" : "Copy"}</span>
      </span>
    </button>
  );
}

/* ——— B · Address focus: pick a chain, read one address big and grouped, one Copy ——— */

function AddressFocus({ auth, me, evmAddress, link, onSignOut }: SheetData) {
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const [copied, copy] = useCopy();
  const address = asset === 0 ? auth.addresses.solana : evmAddress;
  const groups = address ? (address.startsWith("0x") ? ["0x", ...chunk(address.slice(2))] : chunk(address)) : [];
  const chainName = ["Solana", "Ethereum", "HyperEVM"][asset];
  return (
    <div className="asx-b">
      <div className="asx-b-who">
        {me && <PlayerAvatar account={me} size={36} className="asx-b-av" />}
        <div>
          <strong>{me ? <PlayerName account={me} /> : "Your Account"}</strong>
          <span className="meta">{signedInWith(auth)}</span>
        </div>
      </div>

      <AssetPicker value={asset} onChange={setAsset} name="asx-b-chain" />

      <div className="cut cut-card asx-b-plaque">
        <div className="asx-b-plaque-head">
          <ChainGlyph asset={asset} size={28} />
          <div>
            <span className="label">Your {chainName} address</span>
            {asset !== 0 && <small>Same address on Ethereum and HyperEVM</small>}
          </div>
        </div>
        {address ? (
          <code className="asx-b-addr" aria-label={address}>
            {groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </code>
        ) : (
          <span className="meta">Creating your wallet…</span>
        )}
        <button type="button" className="cut cut-btn btn neutral block" disabled={!address} onClick={() => address && copy(address)}>
          {address && copied === address ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {address && copied === address ? "Copied" : "Copy address"}
        </button>
        {asset !== 0 && linkLine(link) && <p className="note">{linkLine(link)}</p>}
      </div>

      <section className="asx-b-wallets">
        <h3 className="label">Your wallets</h3>
        <div className="asx-b-chips">
          {auth.linked.map((w) => (
            <button key={`${w.family}-${w.address}`} type="button" className="cut cut-chip asx-b-chip" title={w.address} onClick={() => copy(w.address)}>
              <ChainGlyph asset={glyph(w.family)} size={16} />
              <b>{walletName(w)}</b>
              <code>{copied === w.address ? "Copied" : short(w.address)}</code>
            </button>
          ))}
          <button type="button" className="cut cut-chip asx-b-chip add" onClick={() => auth.linkWallet("solana")}>
            <Plus aria-hidden="true" /> Solana
          </button>
          <button type="button" className="cut cut-chip asx-b-chip add" onClick={() => auth.linkWallet("evm")}>
            <Plus aria-hidden="true" /> Ethereum
          </button>
        </div>
        <p className="note">A linked wallet shows its .sol, .eth or .hl name on your profile. Your Account holds your Positions and Gemas.</p>
      </section>

      <button type="button" className="asx-quiet asx-b-out" onClick={onSignOut}>
        <LogOut aria-hidden="true" /> Sign out
      </button>
    </div>
  );
}

const chunk = (s: string) => s.match(/.{1,4}/g) ?? [];

/* ——— C · Account map: your Account at the top, what it owns branching under it ——— */

function AccountMap({ auth, me, evmAddress, link, onSignOut }: SheetData) {
  const [copied, copy] = useCopy();
  const sol = auth.addresses.solana;
  return (
    <div className="asx-c">
      <div className="cut cut-card asx-c-root">
        <span className="cut cut-btn asx-c-av">{me && <PlayerAvatar account={me} size={56} />}</span>
        <strong>{me ? <PlayerName account={me} /> : "Your Account"}</strong>
        <span className="meta">{signedInWith(auth)}</span>
        <span className="asx-c-holds">Holds your Positions and Gemas</span>
      </div>

      <div className="asx-c-tree">
        <div className="asx-c-branch">
          <h3 className="label">Made for you</h3>
          <MapNode glyphs={[0]} title="Solana" address={sol} copied={copied} copy={copy} />
          <MapNode glyphs={[1, 2]} title="ETH & HYPE" address={evmAddress} copied={copied} copy={copy} badge={link === "linked" ? "Linked" : undefined} />
        </div>
        <div className="asx-c-branch">
          <h3 className="label">Your wallets</h3>
          {auth.linked.map((w) => (
            <MapNode key={`${w.family}-${w.address}`} glyphs={[glyph(w.family)]} title={walletName(w)} address={w.address} copied={copied} copy={copy} />
          ))}
          <button type="button" className="cut cut-card asx-c-node empty" onClick={() => auth.linkWallet("solana")}>
            <Plus aria-hidden="true" /> <span>Link a Solana wallet</span>
          </button>
          <button type="button" className="cut cut-card asx-c-node empty" onClick={() => auth.linkWallet("evm")}>
            <Plus aria-hidden="true" /> <span>Link an Ethereum wallet</span>
          </button>
        </div>
      </div>

      <p className="note asx-c-note">Linked wallets show their .sol, .eth or .hl name on your profile. Test mode.</p>

      <button type="button" className="cut cut-btn btn neutral block" onClick={onSignOut}>
        <LogOut aria-hidden="true" /> Sign out
      </button>
    </div>
  );
}

function MapNode({
  glyphs,
  title,
  address,
  badge,
  copied,
  copy,
}: {
  glyphs: (0 | 1 | 2)[];
  title: string;
  address: string | null;
  badge?: string;
  copied: string | null;
  copy: (v: string) => void;
}) {
  const done = address !== null && copied === address;
  return (
    <div className="cut cut-card asx-c-node">
      <span className="asx-glyphs">
        {glyphs.map((g) => (
          <ChainGlyph key={g} asset={g} size={18} />
        ))}
      </span>
      <span className="asx-c-text">
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <code title={address ?? undefined}>{address ? short(address) : "Creating…"}</code>
      </span>
      <button type="button" className="asx-c-copy" disabled={!address} aria-label={done ? "Copied" : `Copy ${title} address`} onClick={() => address && copy(address)}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  );
}

/* ——— D · Settings list: grouped label / value rows, everything one glance, sign out as the last row ——— */

function SettingsList({ auth, me, evmAddress, link, onSignOut }: SheetData) {
  const [copied, copy] = useCopy();
  const sol = auth.addresses.solana;
  return (
    <div className="asx-d">
      <div className="asx-d-who">
        {me && <PlayerAvatar account={me} size={44} className="asx-d-av" />}
        <div>
          <strong>{me ? <PlayerName account={me} /> : "Your Account"}</strong>
          <span className="meta">{signedInWith(auth)}</span>
        </div>
      </div>

      <Group title="Addresses" foot="Tesoro made these for your Account. The ETH & HYPE address is the same on Ethereum and HyperEVM.">
        <ValueRow icon={<ChainGlyph asset={0} size={18} />} label="Solana" value={sol} copied={copied} copy={copy} />
        <ValueRow
          icon={
            <span className="asx-glyphs">
              <ChainGlyph asset={1} size={18} />
              <ChainGlyph asset={2} size={18} />
            </span>
          }
          label="ETH & HYPE"
          value={evmAddress}
          copied={copied}
          copy={copy}
        />
        {link !== "unknown" && (
          <div className="asx-d-row">
            <span className="asx-d-label">ETH & HYPE payouts</span>
            <span className={`asx-d-status ${link}`}>{link === "linked" ? "Linked" : "On first Position"}</span>
          </div>
        )}
      </Group>

      <Group title="Linked wallets" foot="Shows your .sol, .eth or .hl name on your profile. Positions and Gemas stay with your Account.">
        {auth.linked.map((w) => (
          <ValueRow key={`${w.family}-${w.address}`} icon={<ChainGlyph asset={glyph(w.family)} size={18} />} label={walletName(w)} value={w.address} copied={copied} copy={copy} />
        ))}
        <button type="button" className="asx-d-row asx-d-link" onClick={() => auth.linkWallet("solana")}>
          <Plus aria-hidden="true" />
          <span className="asx-d-label">Link a Solana wallet</span>
          <small>Phantom, Solflare, Backpack</small>
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="asx-d-row asx-d-link" onClick={() => auth.linkWallet("evm")}>
          <Plus aria-hidden="true" />
          <span className="asx-d-label">Link an Ethereum wallet</span>
          <small>MetaMask, Rabby</small>
          <ChevronRight aria-hidden="true" />
        </button>
      </Group>

      <div className="cut cut-card asx-d-group">
        <button type="button" className="asx-d-row asx-d-out" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          <span className="asx-d-label">Sign out</span>
        </button>
      </div>
      <p className="note asx-d-test">Test mode · Gemas come from simulated yield and have no real value.</p>
    </div>
  );
}

function Group({ title, foot, children }: { title: string; foot?: string; children: React.ReactNode }) {
  return (
    <section className="asx-d-sec">
      <h3 className="label">{title}</h3>
      <div className="cut cut-card asx-d-group">{children}</div>
      {foot && <p className="note">{foot}</p>}
    </section>
  );
}

function ValueRow({
  icon,
  label,
  value,
  copied,
  copy,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  copied: string | null;
  copy: (v: string) => void;
}) {
  const done = value !== null && copied === value;
  return (
    <div className="asx-d-row">
      {icon}
      <span className="asx-d-label">{label}</span>
      <code title={value ?? undefined}>{value ? short(value, 5) : "Creating…"}</code>
      <button type="button" className="asx-d-copy" disabled={!value} aria-label={done ? "Copied" : `Copy ${label} address`} onClick={() => value && copy(value)}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  );
}
