"use client";

/**
 * PROTOTYPE ONLY (branch proto/multichain-11-10-2026). The current "One ledger, every chain" section with
 * add-ons layered on top, picked with `?variant=` on /welcome:
 *   now  the section as shipped
 *   A    Named ledger: the emerald gets its name and what lives on it (Gemas, Matches, Backings)
 *   B    Chain cards: each ticker chip becomes the chain's name plus where its coin stays
 *   C    One at a time: the scene lights one stream at a time (hover a chain to pick) and says it in one line
 *   D    Gemas out: a stream leaves the ledger into "Gemas, any Game", so the story ends at play
 *   E    Three promises: Stays home / One table / Paid in kind under the scene
 *   F    Plain lede: the sentence under the title in Player words
 *   G    A + B + D + F together
 */
import { useEffect, useState, type ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { LockIcon } from "@/components/ui/icons";
import { GemaMark } from "@/components/ui/gema";
import { Stage3D } from "./Stage3D";
import ChainsCanvasLazy from "./chains/ChainsCanvas.lazy";
import { ASPECT, CHAINS, LEDGER, toStage, type ChainsLayout } from "./chains/layout";
import { chainsProto } from "./chains/proto";
import "./multichain.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Named ledger" },
  { key: "B", name: "Chain cards" },
  { key: "C", name: "One at a time" },
  { key: "D", name: "Gemas out" },
  { key: "E", name: "Three promises" },
  { key: "F", name: "Plain lede" },
  { key: "G", name: "A + B + D + F" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { ledger?: boolean; cards?: boolean; focus?: boolean; out?: boolean; promises?: boolean; lede?: boolean };
const FLAGS: Record<Key, Flags> = {
  now: {},
  A: { ledger: true },
  B: { cards: true },
  C: { focus: true },
  D: { out: true },
  E: { promises: true },
  F: { lede: true },
  G: { ledger: true, cards: true, out: true, lede: true },
};

const NAMES = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" } as const;
const STAYS = { SOL: "SOL stays on Solana", ETH: "ETH stays in its vault", HYPE: "HYPE stays in its vault" } as const;
const SAY = {
  SOL: "Lock SOL on Solana. Your Gemas play right where it sits.",
  ETH: "Lock ETH on Ethereum. It never moves; its Gemas play on Solana.",
  HYPE: "Lock HYPE on HyperEVM. It never moves; its Gemas play on Solana.",
} as const;

export function MultichainPrototype() {
  const key = usePrototypeVariant(VARIANTS.map((v) => v.key));
  const f = FLAGS[key];
  const [focus, setFocus] = useState(0);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    chainsProto.out = !!f.out;
    chainsProto.focus = f.focus ? focus : -1;
  }, [f.out, f.focus, focus]);
  useEffect(() => {
    if (!f.focus || pinned) return;
    const id = setInterval(() => setFocus((i) => (i + 1) % CHAINS.length), 3200);
    return () => clearInterval(id);
  }, [f.focus, pinned]);
  useEffect(() => () => void ((chainsProto.out = false), (chainsProto.focus = -1)), []);

  const pick = (i: number | null) => {
    setPinned(i !== null);
    if (i !== null) setFocus(i);
  };

  return (
    <section id="multichain" className="lp-section lp-multichain" aria-labelledby="multichain-title" data-proto={key}>
      <div className="lp-wrap">
        <header className="lp-center-head">
          <h2 id="multichain-title" className="lp-h2" data-reveal>
            One ledger, every chain
          </h2>
          <p className="lp-lede" data-reveal>
            {f.lede
              ? "Lock SOL, ETH or HYPE where it already lives. Every Gema plays at the same table."
              : "Positions stay on their home chains; Tesoro connects them to the Solana ledger."}
          </p>
        </header>
        <div data-reveal>
          {(["wide", "tall"] as const).map((layout) => (
            <Stage3D
              key={layout}
              Canvas={ChainsCanvasLazy}
              layout={layout}
              className={`lp-chains-stage ${layout}`}
              poster={(["", "-light"] as const).map((t) => (
                <picture key={t} className={t ? "on-light" : "on-dark"}>
                  <source type="image/avif" srcSet={`/art/landing/chains-${layout}${t}.avif`} />
                  <img src={`/art/landing/chains-${layout}${t}.webp`} alt="" loading="lazy" decoding="async" />
                </picture>
              ))}
            >
              <Labels layout={layout} f={f} focus={f.focus ? focus : -1} onPick={pick} />
              <span className="lp-chains-aspect" style={{ aspectRatio: String(ASPECT[layout]) }} />
            </Stage3D>
          ))}
          {f.out && (
            <p className="mcp-out-below">
              <GemaMark size={18} /> <b>Gemas</b> · play any Game
            </p>
          )}
          {f.focus && (
            <p className="mcp-say" aria-live="polite">
              <i style={{ background: CHAINS[focus].color }} />
              {SAY[CHAINS[focus].label]}
            </p>
          )}
          {f.promises && (
            <ul className="mcp-promises">
              <Promise icon={<LockIcon width={18} height={18} />} title="Stays home">
                SOL, ETH or HYPE stays locked on its own chain.
              </Promise>
              <Promise icon={<GemaMark size={18} />} title="One table">
                Gemas from every chain play the same Matches.
              </Promise>
              <Promise icon={<span className="mcp-coin">◎</span>} title="Paid in kind">
                Redeemed Gemas pay out in the coin they came from.
              </Promise>
            </ul>
          )}
        </div>
      </div>
      <PrototypeSwitcher variants={VARIANTS} />
    </section>
  );
}

function Promise({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="cut">
      <span className="mcp-promise-icon">{icon}</span>
      <b>{title}</b>
      <span>{children}</span>
    </li>
  );
}

function Labels({ layout, f, focus, onPick }: { layout: ChainsLayout; f: Flags; focus: number; onPick: (i: number | null) => void }) {
  const [lx, ly, lz] = LEDGER[layout];
  return (
    <ul className={`lp-chain-labels${f.focus ? " mcp-pickable" : ""}`} aria-hidden>
      {CHAINS.map((c, i) => {
        const [x, y, z] = c.at[layout];
        const wide = layout === "wide";
        const at = wide ? toStage([x - (f.cards ? 0.7 : 0.95), y, z], layout) : toStage([x, y + 0.85, z], layout);
        const dim = focus >= 0 && focus !== i;
        return (
          <li
            key={c.label}
            className={`chain cut cut-chip${f.cards ? " mcp-card" : ""}${wide && f.cards ? " to-left" : ""}${dim ? " dim" : ""}${focus === i ? " lit" : ""}`}
            style={{ ...at, ["--chain" as string]: c.color }}
            onMouseEnter={f.focus ? () => onPick(i) : undefined}
            onMouseLeave={f.focus ? () => onPick(null) : undefined}
          >
            {f.cards ? (
              <>
                <b>{NAMES[c.label]}</b>
                {wide && <span>{STAYS[c.label]}</span>}
              </>
            ) : (
              c.label
            )}
          </li>
        );
      })}
      {f.ledger && (
        <li className="mcp-ledger" style={toStage(layout === "wide" ? [lx, ly - 1.15, lz] : [lx, ly - 0.95, lz], layout)}>
          <b>Tesoro ledger</b>
          <span>on Solana · Gemas, Matches, Backings</span>
        </li>
      )}
      {f.out && layout === "wide" && (
        <li className="mcp-out cut" style={toStage([5.0, 0, 0], layout)}>
          <GemaMark size={22} />
          <b>Gemas</b>
          <span>play any Game</span>
        </li>
      )}
    </ul>
  );
}
