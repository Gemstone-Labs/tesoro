"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { CATALOGUE } from "@/lib/catalogue";
import { art } from "@/lib/art";
import { commitPendingKey } from "@/lib/chain/commit-pending";
import { matchFee } from "@/lib/chain/ledger";
import { delayedLine, matchStanding } from "@/lib/chain/match-status";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import type { FriendsView } from "@/lib/friends/client";
import "./continue.css";

const subscribeNothing = () => () => {};
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Where a Match stands for its Player, and the action that card leads to. A Match with an opponent comes first. */
function stage(m: ChainMatch, sending = false, nowMs = Date.now()) {
  const standing = matchStanding(m, Math.floor(nowMs / 1000));
  if (standing.kind === "delayed") return { key: "delayed", status: delayedLine(standing, nowMs), action: "View", ready: false };
  if (m.status === "active" && sending) return { key: "sending", status: "Result on its way", action: "View", ready: false };
  if (m.status === "active") return { key: "ready", status: "Opponent found", action: "Resume", ready: true };
  if (m.challenge) return { key: "waiting", status: "Waiting for your friend", action: "Open", ready: false };
  return { key: "waiting", status: m.game === "block-puzzle" ? "Waiting to be paired" : "Looking for an opponent", action: "View", ready: false };
}

function timeLeft(s: number) {
  if (s <= 0) return "Ending";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  const min = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${min ? ` ${min} min` : ""} left`;
}

/** Which card of a sideways row is in view, for the dots under it. */
function useInView(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || count < 2) return;
    const on = () => {
      const card = el.firstElementChild as HTMLElement | null;
      const w = card ? card.offsetWidth + 12 : el.clientWidth;
      setAt(Math.min(count - 1, Math.round(el.scrollLeft / w)));
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [count]);
  return { ref, at };
}

const tileOf = (game: ChainMatch["game"]) => CATALOGUE.find((c) => c.game === game)?.tile ?? "";

export function ContinueSkeleton() {
  return (
    <section className="continue" aria-busy="true" aria-label="Continue">
      <h2 className="h-section">Continue</h2>
      <span className="sr-only" role="status">Loading your open Matches…</span>
      <div className="continue-row" aria-hidden="true">
        <div className="cut cut-card continue-card skel">
          <span className="cut continue-face" />
          <span className="continue-body">
            <span className="continue-game skel-line" style={{ width: "65%" }} />
            <span className="continue-status skel-line" style={{ width: "80%" }} />
            <span className="continue-figures skel-line" style={{ width: "55%" }} />
            <span className="cut cut-btn btn sm continue-cta continue-cta-skel" />
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * The Player's open Matches, then Challenges Friends opened for them. Phones: one wide card at a time, swiped sideways, with
 * dots; wider screens: a grid. Each card: the opponent, the game, where it stands, what is in and what it pays.
 */
export function ContinueRail({
  matches,
  challenges = [],
  title = "Continue",
  rows = false,
}: {
  matches: ChainMatch[];
  challenges?: FriendsView["challenges"];
  title?: string;
  /** A plain list (Matches page) instead of the sideways cards. */
  rows?: boolean;
}) {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(t);
  }, []);
  const sending = useSyncExternalStore(subscribeNothing, commitPendingKey, () => "");
  const st = (m: ChainMatch) => stage(m, sending.split(",").includes(m.id.toString()), now * 1000);
  const sorted = [...matches].sort((a, b) => Number(st(b).ready) - Number(st(a).ready) || a.deadline - b.deadline);
  const count = sorted.length + challenges.length;
  const { ref, at } = useInView(count);

  return (
    <section className={`continue${rows ? " rows" : ""}`} aria-labelledby="live-h">
      <h2 id="live-h" className="h-section">
        {title}
        {rows && <span className="continue-n"> ({count})</span>}
      </h2>
      <div className="continue-row" ref={ref}>
        {sorted.map((m) => {
          const s = st(m);
          return (
            <Link key={m.id.toString()} href={`/play/match/${m.id.toString()}`} className={`cut cut-card continue-card${s.ready ? " ready" : ""}`}>
              <span className="continue-art" aria-hidden="true">
                <Image src={art.hero[m.game]} alt="" fill sizes="(max-width: 700px) 100vw, 980px" />
              </span>
              <span className="cut continue-face" aria-hidden="true">
                {m.opponent ? <PlayerAvatar account={m.opponent} size={64} /> : <Image src={tileOf(m.game)} alt="" fill sizes="64px" />}
              </span>
              <span className="continue-body">
                <span className="continue-game">{GAME_NAMES[m.game]}</span>
                <span className="continue-status">
                  {m.opponent ? (
                    <>
                      vs <PlayerName account={m.opponent} />
                    </>
                  ) : (
                    s.status
                  )}
                </span>
                <span className="continue-figures">
                  <span>
                    <GemaMark size={13} /> {fmtGemas(m.entry)}
                  </span>
                  <span>Win {fmtGemas(m.entry * 2 - matchFee(m))}</span>
                  <span className="continue-time">
                    <Clock aria-hidden="true" /> {timeLeft(m.deadline - now)}
                  </span>
                </span>
                <span className={`cut cut-btn btn sm continue-cta${s.ready ? " ready" : " neutral"}`}>
                  {m.opponent ? s.status : s.action} <ArrowRight aria-hidden="true" />
                </span>
              </span>
            </Link>
          );
        })}
        {challenges.map((c) => (
          <Link key={c.matchId} href={`/play/challenge/${c.matchId}`} className="cut cut-card continue-card ready">
            <span className="continue-art" aria-hidden="true">
              <Image src={art.hero[c.game]} alt="" fill sizes="(max-width: 700px) 100vw, 980px" />
            </span>
            <span className="cut continue-face" aria-hidden="true">
              <PlayerAvatar account={c.from} size={64} />
            </span>
            <span className="continue-body">
              <span className="continue-game">{GAME_NAMES[c.game]}</span>
              <span className="continue-status">
                Challenge from <PlayerName account={c.from} />
              </span>
              <span className="continue-figures">
                <span>
                  <GemaMark size={13} /> {fmtGemas(c.entry)}
                </span>
              </span>
              <span className="cut cut-btn btn sm continue-cta ready">
                Open <ArrowRight aria-hidden="true" />
              </span>
            </span>
          </Link>
        ))}
      </div>
      {count > 1 && !rows && (
        <div className="continue-dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} className={i === at ? "on" : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}
