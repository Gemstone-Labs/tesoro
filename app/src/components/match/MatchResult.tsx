import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, CheckIcon, GemaMark, MinusIcon, XIcon, type BustName } from "@/components/ui";
import { MomentOverlay } from "./MomentOverlay";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import type { GameId } from "@/lib/mock";
import { GAME_NAMES } from "@/lib/mock";
import "./match.css";

export type Outcome = "won" | "lost" | "draw" | "refunded";

export interface MatchResultProps {
  game: GameId;
  outcome: Outcome;
  /** The Gema change for whoever is looking (the Player's, or the Backer's when `role` is backer). */
  delta: number;
  entry: number;
  /** Platform + Studio Fee taken from the Pot, in Gemas. */
  fee: number;
  role: "player" | "backer";
  backed: boolean;
  /** Final scores as shown: [yours, opponent's]. Null when the Match has none (refund). */
  scores: [string, string] | null;
  scoreNote?: string;
  playAgainHref: string;
  /** Show the win overlay once per key (the Match id); without one it shows on every mount. */
  momentKey?: string;
  /** How a Backing paid out (BackingSplit), for backed Matches. */
  split?: ReactNode;
  /** Extra footer content (transactions, notes). */
  children?: ReactNode;
}

const RULES: Record<GameId, { chip: string; line: string }> = {
  "block-puzzle": { chip: "Same Seed", line: "90 seconds · higher score wins" },
  holdem: { chip: "Heads-up", line: "Turbo blinds · last stack standing" },
};

/** Faceted emerald burst behind the won amount: hard-stop shards and a few sparkles. Decorative. */
function GemaBurst() {
  const shards = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    const w = 0.09 + (i % 3) * 0.03;
    const r1 = 260 + (i % 4) * 40;
    const p = (ang: number, r: number) => `${300 + Math.cos(ang) * r},${150 + Math.sin(ang) * r * 0.6}`;
    return <polygon key={i} points={`300,150 ${p(a - w, r1)} ${p(a + w, r1)}`} fill="url(#mr-ray)" opacity={0.55 - (i % 3) * 0.12} />;
  });
  const sparks = [[92, 70], [520, 60], [560, 190], [70, 215], [455, 262], [150, 268], [330, 20]];
  return (
    <svg className="mr-burst" viewBox="0 0 600 300" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="mr-ray" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#63f7d3" stopOpacity=".55" />
          <stop offset="1" stopColor="#0cbc8c" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mr-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#24d8a8" stopOpacity=".38" />
          <stop offset="1" stopColor="#24d8a8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="300" cy="150" rx="290" ry="150" fill="url(#mr-glow)" />
      {shards}
      {sparks.map(([x, y], i) => (
        <polygon key={i} points={`${x},${y - 6} ${x + 4},${y} ${x},${y + 6} ${x - 4},${y}`} fill="#8ff5cf" opacity={0.8} />
      ))}
    </svg>
  );
}

/** The moment overlay's bust: only for wins (a Player's, or a Backer's backed win). Nothing else has a character. */
function momentBust(p: MatchResultProps): { bust: BustName; title: string } | null {
  if (p.outcome !== "won") return null;
  if (p.role === "backer" && p.backed) return { bust: "duoWin", title: "Backed win" };
  return p.role === "player" ? { bust: "himWin", title: "You won" } : null;
}

/**
 * The Match result, both games. Game tile and rules left, the outcome and amount centre. No
 * character on the screen itself: a win gets a short overlay (MomentOverlay). Won Gemas are claims on the loser's Source, so a win always
 * says so and links to the Wallet: never implies cash in hand.
 */
export function MatchResult(p: MatchResultProps) {
  const { outcome, role, backed, delta } = p;
  const won = outcome === "won";
  const lost = outcome === "lost";
  const neutral = outcome === "draw" || outcome === "refunded";
  const moment = momentBust(p);
  const rules = RULES[p.game];
  const mag = fmtGemas(Math.abs(delta));
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";

  const status = won ? "Won" : lost ? "Lost" : outcome === "draw" ? "Draw" : "Refunded";
  const Icon = won ? CheckIcon : lost ? XIcon : MinusIcon;
  const amountLabel = backed ? (role === "backer" ? "Your return" : "Your share") : null;

  return (
    <div className="stack-lg mr">
      <nav className="mr-crumbs" aria-label="Breadcrumb">
        <Link href={`/play/${p.game}`}>Play</Link>
        <span aria-hidden="true">/</span>
        <span>{GAME_NAMES[p.game]}</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Match result</span>
      </nav>
      <h1 className="page-title mr-title">Match result</h1>

      <section className={`cut cut-frame mr-frame${won ? " won" : ""}`} aria-label={`Match result: ${status}`}>
        <div className="mr-left">
          <div className="cut cut-card mr-tile">
            <Image src={art.thumb[p.game]} alt="" width={260} height={260} priority />
            <span className="mr-tile-name">{GAME_NAMES[p.game]}</span>
          </div>
          <span className="cut cut-card mr-rule-chip">{rules.chip}</span>
          <p className="mr-rule">{rules.line}</p>
          {p.game === "holdem" && <p className="mr-rule">Chips are in-match scorekeeping, not Gemas.</p>}
        </div>

        <div className="mr-mid">
          <div className={`mr-status ${status.toLowerCase()}`}>
            <span className="mr-status-icon"><Icon /></span>
            {status}
          </div>

          <div className="mr-amount-wrap">
            {won && <GemaBurst />}
            {amountLabel && <span className="mr-amount-label">{amountLabel}</span>}
            {neutral ? (
              <div className="mr-neutral">
                <b>{outcome === "draw" ? "Entry returned" : "Entry refunded"}</b>
                <span className="mr-neutral-amt"><GemaMark size={30} /> {fmtGemas(p.entry)} Gemas</span>
              </div>
            ) : (
              <div className={`mr-amount${won ? " won" : ""}`}>
                {won && <GemaMark size={150} />}
                <span className="mr-figure">
                  {sign}
                  {mag}
                </span>
                <span className="mr-unit">Gemas</span>
              </div>
            )}
          </div>

          {won && (
            <Link className="mr-pending" href="/wallet">
              Pending · redeemable as their yield lands <span aria-hidden="true">→</span>
            </Link>
          )}
          {lost && role === "player" && !backed && (
            <p className="mr-copy">Tough one. Your entry went to the winner, and your Principal was never in play. The next Match is one tap away.</p>
          )}
          {backed && role === "player" && <p className="mr-copy strong">You never owe anything, win or lose: your Backer&apos;s Gemas funded this entry.</p>}
          {neutral && !backed && (
            <p className="mr-copy">
              {outcome === "draw" ? "Equal scores: both entries were returned." : "The Match ended without a result and your entry was returned."}
            </p>
          )}

          {p.scores && (
            <div className="cut cut-card mr-scores">
              <div>
                <span>{role === "backer" ? "Your Player" : "You"}</span>
                <b className="tnum">{p.scores[0]}</b>
              </div>
              <div>
                <span>Opponent</span>
                <b className="tnum dim">{p.scores[1]}</b>
              </div>
            </div>
          )}
          {p.scoreNote && <p className="note">{p.scoreNote}</p>}

          <div className="cut cut-card mr-fees">
            <div>
              <span>Entry</span>
              <b>
                <GemaMark size={26} /> {fmtGemas(p.entry)} <small>Gemas</small>
              </b>
            </div>
            <div>
              <span>Fee</span>
              <b>
                <GemaMark size={26} /> {fmtGemas(neutral ? 0 : p.fee)} <small>Gemas</small>
              </b>
            </div>
          </div>
          {p.split && <div className="mr-split">{p.split}</div>}
        </div>

      </section>
      {moment && <MomentOverlay bust={moment.bust} title={moment.title} amount={Math.abs(delta)} momentKey={p.momentKey} />}

      <div className="mr-actions">
        {role === "backer" ? (
          <Button variant="money" size="lg" href="/backing">Back a Player</Button>
        ) : (
          <Button variant="money" size="lg" href={p.playAgainHref}>Play again</Button>
        )}
        <Button size="lg" href="/">Lobby</Button>
        <Button size="lg" href="/wallet">Wallet</Button>
      </div>
      {p.children}
    </div>
  );
}
