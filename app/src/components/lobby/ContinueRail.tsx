"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { CATALOGUE } from "@/lib/catalogue";
import { matchFee } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./continue.css";

const nowSecs = () => Math.floor(Date.now() / 1000);

/** Where a Match stands for its Player, and the action that card leads to. A Match with an opponent comes first. */
function stage(m: ChainMatch) {
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

/** The Player's open Matches: game art, where each stands, what is in and what it pays, and the time left. */
export function ContinueRail({ matches }: { matches: ChainMatch[] }) {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(t);
  }, []);
  const sorted = [...matches].sort((a, b) => Number(stage(b).ready) - Number(stage(a).ready) || a.deadline - b.deadline);

  return (
    <section className="rail" aria-labelledby="live-h">
      <header className="rail-head">
        <h2 id="live-h" className="h-section">Continue</h2>
      </header>
      <div className="continue-grid">
        {sorted.map((m) => {
          const s = stage(m);
          return (
            <Link key={m.id.toString()} href={`/play/match/${m.id.toString()}`} className={`cut cut-card continue-card${s.ready ? " ready" : ""}`}>
              <span className="continue-art" aria-hidden="true">
                <Image src={CATALOGUE.find((c) => c.game === m.game)?.tile ?? ""} alt="" fill sizes="76px" />
              </span>
              <span className="continue-body">
                <span className="continue-game">{GAME_NAMES[m.game]}</span>
                <span className="continue-status">
                  <i className={s.key} aria-hidden="true" />
                  {s.status}
                </span>
                <span className="continue-figures">
                  <span>
                    <GemaMark size={12} /> {fmtGemas(m.entry)} in
                  </span>
                  <span>Win {fmtGemas(m.entry * 2 - matchFee(m))}</span>
                  <span className="continue-time">
                    <Clock aria-hidden="true" /> {timeLeft(m.deadline - now)}
                  </span>
                </span>
              </span>
              <span className={`cut cut-btn btn sm continue-cta${s.ready ? " ready" : " neutral"}`}>
                {s.action} <ArrowRight aria-hidden="true" />
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
