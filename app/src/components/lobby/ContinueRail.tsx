"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { CATALOGUE } from "@/lib/catalogue";
import { commitPendingKey } from "@/lib/chain/commit-pending";
import { matchFee } from "@/lib/chain/ledger";
import { probeRun, type RunStage } from "@/lib/chain/match-flow";
import { delayedLine, matchStanding } from "@/lib/chain/match-status";
import { playRunLine, unplayedRun } from "@/lib/chain/run-status";
import { useAccount } from "@/lib/account";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import type { FriendsView } from "@/lib/friends/client";
import "./continue.css";

const subscribeNothing = () => () => {};
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Where a Match stands for its Player, and the action that card leads to. A Match with an opponent comes first. */
function stage(m: ChainMatch, sending = false, nowMs = Date.now(), run?: RunStage) {
  const standing = matchStanding(m, Math.floor(nowMs / 1000));
  if (standing.kind === "delayed") return { key: "delayed", status: delayedLine(standing, nowMs), action: "View", ready: false };
  const unplayed = unplayedRun(m, Math.floor(nowMs / 1000), run);
  if (unplayed) return { key: "ready", status: playRunLine(unplayed, nowMs), action: "Play", ready: true };
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

/** Where the Player's own run stands in each open Block Burst Match (the Board lives in the rollup, so it is probed without ever asking the wallet to sign on the Lobby). */
function useRunStages(matches: ChainMatch[]) {
  const { auth } = useAccount();
  const signer = auth.signer;
  const [stages, setStages] = useState<Record<string, RunStage>>({});
  const ids = matches
    .filter((m) => m.game === "block-puzzle" && m.seat !== null && m.session && !m.session.settled)
    .map((m) => m.id.toString())
    .join(",");
  useEffect(() => {
    if (!signer || !ids) return;
    let stopped = false;
    const wanted = new Set(ids.split(","));
    for (const m of matches) {
      const k = m.id.toString();
      if (!wanted.has(k)) continue;
      probeRun(signer, m, false, true).then(
        (r) => !stopped && setStages((s) => (s[k] === r ? s : { ...s, [k]: r })),
        () => undefined,
      );
    }
    return () => {
      stopped = true;
    };
    // Probe when the set of Matches changes, not on every Account refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, ids]);
  return stages;
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

/**
 * The Player's open Matches, then Challenges Friends opened for them. Phones: one wide card at a time, swiped sideways, with
 * dots; wider screens: a grid. Each card: the opponent, the game, where it stands, what is in and what it pays.
 */
export function ContinueRail({ matches, challenges = [] }: { matches: ChainMatch[]; challenges?: FriendsView["challenges"] }) {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(t);
  }, []);
  const sending = useSyncExternalStore(subscribeNothing, commitPendingKey, () => "");
  const runs = useRunStages(matches);
  const st = (m: ChainMatch) => stage(m, sending.split(",").includes(m.id.toString()), now * 1000, runs[m.id.toString()]);
  const sorted = [...matches].sort((a, b) => Number(st(b).ready) - Number(st(a).ready) || a.deadline - b.deadline);
  const count = sorted.length + challenges.length;
  const { ref, at } = useInView(count);

  return (
    <section className="continue" aria-labelledby="live-h">
      <h2 id="live-h" className="h-section">Continue</h2>
      <div className="continue-row" ref={ref}>
        {sorted.map((m) => {
          const s = st(m);
          return (
            <Link key={m.id.toString()} href={`/play/match/${m.id.toString()}`} className={`cut cut-card continue-card${s.ready ? " ready" : ""}`}>
              <span className="continue-art" aria-hidden="true">
                <Image src={tileOf(m.game)} alt="" fill sizes="(min-width: 1024px) 220px, 60vw" />
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
              <Image src={tileOf(c.game)} alt="" fill sizes="(min-width: 1024px) 220px, 60vw" />
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
      {count > 1 && (
        <div className="continue-dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} className={i === at ? "on" : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}
