"use client";

// PROTOTYPE: variants of the Lobby "Continue" rail (your open Matches).
// Five variants on /lobby, switchable via ?variant=A..E and the floating bar (← / → keys).
// ?demo=1 swaps in three fake Matches (one per Game and status). Throwaway: lives on
// proto/lobby-continue-10-10-2026 only.
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock, Link2, Swords } from "lucide-react";
import { PlayerAvatar } from "@/components/account/Player";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { GemaMark } from "@/components/ui";
import { Row, Thumb } from "@/components/ui";
import { art } from "@/lib/art";
import { CATALOGUE } from "@/lib/catalogue";
import { matchFee } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./continue.prototype.css";

export const CONTINUE_VARIANTS = [
  { key: "A", name: "Current" },
  { key: "B", name: "Art tiles" },
  { key: "C", name: "Versus" },
  { key: "D", name: "Ticket + steps" },
  { key: "E", name: "Up next" },
];

export function ContinueSwitcher() {
  return <PrototypeSwitcher variants={CONTINUE_VARIANTS} />;
}

const now = () => Math.floor(Date.now() / 1000);
const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };

/** MOCK: three Matches covering the states the rail has to show. */
function demoMatches(): ChainMatch[] {
  const t = now();
  const base = { address: null, seat: 0, sides: [null, null], backerSeat: null, backing: null, fees: FEES, winner: null, session: null } as const;
  return [
    { ...base, id: 1n, game: "holdem", status: "active", entry: 2500, opponent: "HCDJbe6QRLgPEHKkNt5gdi7cASwN2VNpKH9aguPh4Pgc", deadline: t + 52 * 60, challenge: false },
    { ...base, id: 2n, game: "block-puzzle", status: "open", entry: 1000, opponent: null, deadline: t + 41 * 60, challenge: false },
    { ...base, id: 3n, game: "trading-duel", status: "open", entry: 500, opponent: null, deadline: t + 23 * 3600, challenge: true },
  ] as unknown as ChainMatch[];
}

export function useContinue(real: ChainMatch[]) {
  const params = useSearchParams();
  const variant = params.get("variant") ?? "A";
  const matches = params.get("demo") ? demoMatches() : real;
  return { variant, matches };
}

function useNow() {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

const left = (s: number) => (s <= 0 ? "ending" : s < 3600 ? `${Math.ceil(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);
const tile = (m: ChainMatch) => CATALOGUE.find((c) => c.game === m.game)?.tile ?? "";
const win = (m: ChainMatch) => m.entry * 2 - matchFee(m);
const href = (m: ChainMatch) => `/play/match/${m.id.toString()}`;

/** What the Player sees for each Match: one short status, whose move it is, the action. */
function stage(m: ChainMatch) {
  if (m.status === "active") return { key: "ready", status: "Opponent found", hint: "Your move", action: "Resume", urgent: true };
  if (m.challenge) return { key: "challenge", status: "Waiting for your friend", hint: "Share the link again", action: "Open", urgent: false };
  if (m.game === "block-puzzle") return { key: "paired", status: "Waiting to be paired", hint: "Your score is in", action: "View", urgent: false };
  return { key: "queue", status: "Looking for an opponent", hint: "In the Queue", action: "View", urgent: false };
}

const order = (ms: ChainMatch[]) => [...ms].sort((a, b) => Number(stage(b).urgent) - Number(stage(a).urgent) || a.deadline - b.deadline);

/* A — what main ships today. */
export function ContinueCurrent({ matches }: { matches: ChainMatch[] }) {
  return (
    <div className="live-grid">
      {matches.map((m) => (
        <Row
          key={m.id.toString()}
          href={href(m)}
          thumb={<Thumb>{m.entry >= 1000 ? `${m.entry / 1000}K` : m.entry}</Thumb>}
          title={`${GAME_NAMES[m.game]} · ${fmtGemas(m.entry)} entry`}
          meta={m.status === "open" ? (m.challenge ? "Waiting for your Challenge to be opened" : m.game === "block-puzzle" ? "Waiting to be paired" : "Waiting for an opponent") : "Opponent found · continue"}
          cta="Open"
        />
      ))}
    </div>
  );
}

/* B — Art tiles: the game's art carries the card; Pot and status read at a glance; a Match waiting on you gets the lit edge. */
export function ContinueTiles({ matches }: { matches: ChainMatch[] }) {
  const t = useNow();
  return (
    <div className="ct-tiles">
      {order(matches).map((m) => {
        const s = stage(m);
        return (
          <Link key={m.id.toString()} href={href(m)} className={`cut cut-card ct-tile${s.urgent ? " urgent" : ""}`}>
            <span className="ct-tile-art">
              <Image src={tile(m)} alt="" fill sizes="120px" />
            </span>
            <span className="ct-tile-body">
              <span className="ct-tile-game">{GAME_NAMES[m.game]}</span>
              <span className="ct-tile-status">
                <i className={`ct-dot ${s.key}`} aria-hidden="true" />
                {s.status}
              </span>
              <span className="ct-tile-figures">
                <span>
                  <GemaMark size={12} /> {fmtGemas(m.entry)} in
                </span>
                <span>Win {fmtGemas(win(m))}</span>
                <span className="ct-muted">
                  <Clock aria-hidden="true" /> {left(m.deadline - t)}
                </span>
              </span>
            </span>
            <span className={`cut cut-btn btn neutral sm ct-tile-cta${s.urgent ? " primary" : ""}`}>
              {s.action} <ArrowRight aria-hidden="true" />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* C — Versus: the people are the story. You vs them (or an empty seat), the Pot between you, time running out underneath. */
export function ContinueVersus({ matches, me }: { matches: ChainMatch[]; me: string }) {
  const t = useNow();
  return (
    <div className="ct-vs-grid">
      {order(matches).map((m) => {
        const s = stage(m);
        const span = m.status === "active" ? 3600 : m.challenge ? 24 * 3600 : 3600;
        const frac = Math.max(0, Math.min(1, (m.deadline - t) / span));
        return (
          <Link key={m.id.toString()} href={href(m)} className={`cut cut-card ct-vs${s.urgent ? " urgent" : ""}`}>
            <span className="ct-vs-head">
              <Image src={tile(m)} alt="" width={22} height={22} />
              {GAME_NAMES[m.game]}
              {m.challenge && <em>Challenge</em>}
            </span>
            <span className="ct-vs-faces">
              <span className="ct-vs-seat">
                <PlayerAvatar account={me} size={52} />
                <small>You</small>
              </span>
              <span className="ct-vs-pot">
                <b>VS</b>
                <span>
                  <GemaMark size={12} /> {fmtGemas(win(m))}
                </span>
              </span>
              <span className="ct-vs-seat">
                {m.opponent ? <PlayerAvatar account={m.opponent} size={52} /> : <i className="ct-vs-empty">{m.challenge ? <Link2 aria-hidden="true" /> : "?"}</i>}
                <small>{m.opponent ? "Opponent" : m.challenge ? "Your friend" : "Searching…"}</small>
              </span>
            </span>
            <span className="ct-vs-foot">
              <span>
                <strong>{s.status}</strong> · {s.action}
              </span>
              <span className="ct-muted">{left(m.deadline - t)} left</span>
            </span>
            <span className="ct-vs-bar" aria-hidden="true">
              <i style={{ width: `${frac * 100}%` }} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* D — Ticket: entry stub, the Match's progress as steps, the Pot stub. Reads like a bet slip you are holding. */
const STEPS = ["Entered", "Paired", "Played", "Paid out"];
function stepOf(m: ChainMatch) {
  if (m.status === "active") return 2;
  if (m.game === "block-puzzle") return 1;
  return 1;
}
export function ContinueTickets({ matches }: { matches: ChainMatch[] }) {
  const t = useNow();
  return (
    <div className="ct-tickets">
      {order(matches).map((m) => {
        const s = stage(m);
        const at = stepOf(m);
        return (
          <Link key={m.id.toString()} href={href(m)} className={`ct-ticket${s.urgent ? " urgent" : ""}`}>
            <span className="ct-stub">
              <small>Entry</small>
              <b>
                <GemaMark size={14} /> {fmtGemas(m.entry)}
              </b>
            </span>
            <span className="ct-ticket-mid">
              <span className="ct-ticket-title">
                {GAME_NAMES[m.game]}
                <span className="ct-muted">
                  {s.status} · {left(m.deadline - t)} left
                </span>
              </span>
              <ol className="ct-steps">
                {STEPS.map((label, i) => (
                  <li key={label} className={i < at ? "done" : i === at ? "now" : undefined}>
                    <i>{i < at ? <Check aria-hidden="true" /> : null}</i>
                    {label}
                  </li>
                ))}
              </ol>
            </span>
            <span className="ct-stub end">
              <small>Win</small>
              <b>{fmtGemas(win(m))}</b>
              <span className="ct-stub-go">
                {s.action} <ArrowRight aria-hidden="true" />
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* E — Up next: one Match leads (the one waiting on you, else the closest to its deadline) as a wide art banner; the rest are small chips. */
export function ContinueUpNext({ matches }: { matches: ChainMatch[] }) {
  const t = useNow();
  const [lead, ...rest] = order(matches);
  const s = stage(lead);
  const hero = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero }[lead.game];
  return (
    <div className="ct-next">
      <Link href={href(lead)} className={`cut cut-frame ct-next-lead${s.urgent ? " urgent" : ""}`}>
        <span className="ct-next-art">
          <Image src={hero} alt="" fill sizes="(min-width: 1024px) 60vw, 100vw" />
        </span>
        <span className="ct-next-body">
          <small className="ct-next-kicker">{s.urgent ? <><Swords aria-hidden="true" /> {s.hint}</> : "Up next"}</small>
          <span className="ct-next-title">{GAME_NAMES[lead.game]}</span>
          <span className="ct-next-meta">
            {s.status} · <GemaMark size={13} /> {fmtGemas(lead.entry)} in · Win {fmtGemas(win(lead))} · {left(lead.deadline - t)} left
          </span>
        </span>
        <span className={`cut cut-btn btn neutral ${s.urgent ? "primary" : ""} ct-next-cta`}>
          {s.action} <ArrowRight aria-hidden="true" />
        </span>
      </Link>
      {rest.length > 0 && (
        <div className="ct-next-rest">
          {rest.map((m) => {
            const r = stage(m);
            return (
              <Link key={m.id.toString()} href={href(m)} className="cut cut-chip ct-chip">
                <Image src={tile(m)} alt="" width={28} height={28} />
                <span>
                  <b>{GAME_NAMES[m.game]}</b>
                  <small>
                    {r.status} · {left(m.deadline - t)}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
