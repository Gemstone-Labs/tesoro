"use client";

import { useState, type ReactNode } from "react";
import {
  BalanceCard,
  BalanceSplit,
  Button,
  Card,
  ChainChip,
  CheckIcon,
  Chip,
  CrossChainProgress,
  EntryPicker,
  GemaAmount,
  GemaMark,
  Label,
  PendingBySource,
  Row,
  Sheet,
  SimulatedYieldLabel,
  Slider,
  Thumb,
  XIcon,
} from "@/components/ui";
import { AccountSheet } from "@/components/shell/AccountSheet";
import { AuthContext } from "@/lib/auth/context";
import type { AuthState } from "@/lib/auth/types";
import type { EntrySize } from "@/lib/mock";

/** Sample data only: lets the Account sheet render here without a Privy session. */
const SAMPLE_AUTH: AuthState = {
  status: "signed-in",
  email: "ana@example.com",
  addresses: {
    solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    evm: "0x4Ce2a8b91F0d3E57c1A6d9f2B08E7a3d51c6F9a2",
  },
  linked: [{ family: "solana", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", client: "phantom" }],
  signOut: async () => {},
  linkWallet: () => {},
  gate: (_r, a) => a(),
  openSignIn: () => {},
  openAccount: () => {},
  signer: null,
  evm: null,
  externalSolana: null,
  externalEvm: null,
  getAccessToken: async () => null,
  devWallet: false,
};

const TOKENS: [string, string][] = [
  ["--shell", "#0C0E10"], ["--raised", "#15181B"], ["--line", "rgba(234,239,236,.10)"],
  ["--fg", "#EAEFEC"], ["--fg-2", "rgba(234,239,236,.62)"], ["--fg-3", "rgba(234,239,236,.40)"],
  ["--em-hi", "#8FF5CF"], ["--em", "#2DBE8C"], ["--em-deep", "#0B6B4E"], ["--em-ink", "#03201A"],
  ["--danger", "#F2685A"], ["--warn", "#F2B94B"],
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="stack" aria-label={title}>
      <div className="stack" style={{ gap: 2 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900 }}>{title}</h2>
        {note && <p className="meta">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const grid = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", alignItems: "start" } as const;

export default function Design() {
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [h, setH] = useState(4);
  const [sheet, setSheet] = useState(false);
  const [accountSheet, setAccountSheet] = useState(false);

  return (
    <div className="stack-lg">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Design system</h1>
        <p className="meta">
          Direction &quot;Cut&quot;. Every component and state used by the app. Import from <span className="mono">@/components/ui</span>.
        </p>
      </div>

      <Section title="Tokens" note="CSS custom properties in globals.css. Emerald means Gemas move.">
        <div style={grid}>
          {TOKENS.map(([name, val]) => (
            <div key={name} className="hstack">
              <span className="cut cut-chip" style={{ width: 36, height: 36, background: `var(${name})`, border: "1px solid var(--line)", flex: "none" }} />
              <span className="stack" style={{ gap: 0 }}>
                <span className="mono" style={{ fontSize: 12 }}>{name}</span>
                <span className="mono meta" style={{ fontSize: 11 }}>{val}</span>
              </span>
            </div>
          ))}
          <div className="hstack">
            <span className="cut cut-chip" style={{ width: 36, height: 36, background: "var(--facet)", flex: "none" }} />
            <span className="mono" style={{ fontSize: 12 }}>--facet</span>
          </div>
          <div className="hstack">
            <span className="cut cut-chip" style={{ width: 36, height: 36, background: "var(--money-fill)", flex: "none" }} />
            <span className="mono" style={{ fontSize: 12 }}>--money-fill</span>
          </div>
        </div>
      </Section>

      <Section title="Type" note="Schibsted Grotesk for everything; IBM Plex Mono only for verifiable data.">
        <div className="stack">
          <span style={{ fontSize: 40, fontWeight: 900, letterSpacing: "-.03em" }} className="tnum">15,000 Gemas</span>
          <span style={{ fontSize: 24, fontWeight: 900, letterSpacing: "-.02em" }}>Page title</span>
          <span style={{ fontSize: 14 }}>Body 14 / 400. Money is plain, big and honest.</span>
          <Label>Label 11 / 700 caps</Label>
          <span className="mono">Pieces #9f3a1c · 01:30</span>
        </div>
      </Section>

      <Section title="Cut" note="Three sizes: frame 22px, card 10px, chip 6px. Use .cut with .cut-frame / .cut-card / .cut-chip. Focus rings sit inside because clip-path clips outside.">
        <div className="hstack" style={{ flexWrap: "wrap", gap: 16 }}>
          {(["cut-frame", "cut-card", "cut-chip"] as const).map((c) => (
            <div key={c} className={`cut ${c}`} style={{ width: 120, height: 80, background: "var(--raised)", border: "1px solid var(--line)", display: "grid", placeItems: "center" }}>
              <span className="mono" style={{ fontSize: 11 }}>{c}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Gema mark and amount" note="Glint runs on the balance only and is off under prefers-reduced-motion.">
        <div className="hstack" style={{ gap: 20, flexWrap: "wrap" }}>
          <GemaMark size={16} /><GemaMark size={30} /><GemaMark size={30} glint />
          <GemaAmount value={1240} size="sm" />
          <GemaAmount value={1240} size="md" />
          <GemaAmount value={1240} size="lg" />
          <GemaAmount value={15000} size="xl" glint />
        </div>
        <div className="hstack" style={{ gap: 20, flexWrap: "wrap" }}>
          <GemaAmount value={1900} size="md" sign />
          <GemaAmount value={-1000} size="md" sign />
          <SimulatedYieldLabel />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="hstack" style={{ flexWrap: "wrap" }}>
          <Button variant="money">Enter · 1,000 Gemas</Button>
          <Button variant="neutral">Post Request</Button>
          <Button variant="money" size="sm">Offer</Button>
          <Button size="sm">Apply</Button>
          <Button variant="money" disabled>Redeem 0</Button>
          <Button disabled>Disabled</Button>
        </div>
        <Button variant="money" block>Redeem 1,599 (block)</Button>
      </Section>

      <Section title="Chips" note="Results carry an icon and words, never colour alone.">
        <div className="hstack" style={{ flexWrap: "wrap" }}>
          <ChainChip chain="SOL" /><ChainChip chain="ETH" /><ChainChip chain="HYPE" />
          <Chip>Neutral</Chip>
          <Chip tone="strong">Strong</Chip>
          <Chip tone="money" icon={<CheckIcon />}>Won</Chip>
          <Chip tone="danger" icon={<XIcon />}>Lost</Chip>
          <Chip tone="warn">Pending</Chip>
        </div>
      </Section>

      <Section title="EntryPicker" note="500 / 1,000 / 2,500. The chosen entry is emerald and carries the Gema mark. Disabled when unaffordable.">
        <div className="stack" style={{ maxWidth: 420 }}>
          <EntryPicker value={entry} onChange={setEntry} name="ds-entry" legend="Entry" />
          <EntryPicker value={1000} onChange={() => {}} name="ds-entry-lim" legend="Entry, limited" maxAffordable={1200} />
        </div>
      </Section>

      <Section title="Card and Row">
        <div style={grid}>
          <Card>Card content. One corner size per class.</Card>
          <Row game="holdem" title="Heads-up Hold'em" meta="Live · 2 in Queue" cta="Play" href="/play/holdem" />
          <Row game="block-puzzle" title="Block Puzzle" meta="vs Otter · 171 – 140" when="2 min ago" delta={900} cta="Open" href="/matches" />
          <Row thumb={<Thumb>D</Thumb>} title="Dana asks for 1,000" meta="Block Puzzle · 38 Matches · 61% won" cta="Offer" ctaTone="money" onClick={() => {}} />
          <Row title="Static row" meta="No action" />
        </div>
      </Section>

      <Section title="Balance, split, pending">
        <div style={grid}>
          <div className="stack">
            <BalanceCard total={10060} />
            <BalanceSplit redeemable={1599} pending={8461} redeemableSources={4} />
          </div>
          <Card large>
            <PendingBySource
              items={[
                { key: "a", chain: "HYPE", owner: "Bob's Position", pending: 2200, accruedShare: 0.12 },
                { key: "b", chain: "ETH", owner: "Carol's Position", pending: 1197, accruedShare: 0.71 },
                { key: "c", chain: "SOL", owner: "Your Position", pending: 4316, accruedShare: 0 },
              ]}
            />
          </Card>
        </div>
      </Section>

      <Section title="Slider" note="Horizon 1–12 months; also the Player's share of the surplus.">
        <div style={{ maxWidth: 420 }}>
          <Slider label="Horizon" value={h} min={1} max={12} onChange={setH} display={`${h} ${h === 1 ? "month" : "months"}`} minLabel="1 month" maxLabel="12 months" />
        </div>
      </Section>

      <Section title="CrossChainProgress" note="Success shows only at the final step. Pending never shows success early.">
        <div style={grid}>
          {([0, 1, 2, 3] as const).map((s) => (
            <Card key={s} large><CrossChainProgress stage={s} chain="ETH" txHash="0x7be1…a09c" /></Card>
          ))}
          <Card large><CrossChainProgress stage={1} failed chain="HYPE" /></Card>
        </div>
      </Section>

      <Section title="Account sheet" note="Sample addresses; the real one reads the Privy session.">
        <div><Button onClick={() => setAccountSheet(true)}>Open Account sheet</Button></div>
        <AuthContext.Provider value={SAMPLE_AUTH}>
          <AccountSheet open={accountSheet} onClose={() => setAccountSheet(false)} onSignedOut={() => setAccountSheet(false)} />
        </AuthContext.Provider>
      </Section>

      <Section title="Sheet" note="Native dialog: focus trap, Esc, backdrop click.">
        <div><Button onClick={() => setSheet(true)}>Open sheet</Button></div>
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Sheet title">
          <p className="meta">Bottom sheet on phones, centred on wide screens.</p>
          <Button variant="money" block onClick={() => setSheet(false)}>Confirm</Button>
        </Sheet>
      </Section>
    </div>
  );
}
