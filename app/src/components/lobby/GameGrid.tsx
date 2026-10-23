"use client";

import Image from "next/image";
import Link from "next/link";
import type { PointerEvent } from "react";
import { Clock, Users } from "lucide-react";
import { ENTRY_SIZES } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { waitingByEntry } from "@/lib/chain/lobby-plays";
import { CATALOGUE } from "@/lib/catalogue";
import { useQueue } from "./useQueue";

/** Tilt a tile toward the pointer and move its glare with it (mouse only; still under reduced motion). */
function tilt(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty("--ry", `${(x - 0.5) * 7}deg`);
  el.style.setProperty("--rx", `${(0.5 - y) * 6}deg`);
  el.style.setProperty("--gx", `${x * 100}%`);
  el.style.setProperty("--gy", `${y * 100}%`);
}
function untilt(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  ["--rx", "--ry", "--gx", "--gy"].forEach((p) => el.style.removeProperty(p));
}

/** GAMES: every live Game as an art tile with its name and how many Players wait. A tile opens the Game page (entry, Play now). */
export function GameGrid() {
  const queue = useQueue();
  const me = useAccount().snapshot?.accountKey.toBase58();
  const live = CATALOGUE.filter((g) => g.live);
  const soon = CATALOGUE.filter((g) => !g.live);

  return (
    <section className="games" aria-labelledby="games-h">
      <h2 id="games-h" className="h-section">Games</h2>
      <div className="games-grid">
        {live.map((g) => {
          const waiting = g.game && queue ? Object.values(waitingByEntry(queue[g.game], ENTRY_SIZES, me)).reduce((a, n) => a + n, 0) : 0;
          return (
            <Link key={g.key} href={`/play/${g.game}`} className="cut cut-frame tile game-tile" onPointerMove={tilt} onPointerLeave={untilt}>
              <Image src={g.tile} alt="" fill sizes="(min-width: 1024px) 22vw, 50vw" />
              <span className="tile-shade" aria-hidden="true" />
              <span className="tile-glare" aria-hidden="true" />
              {waiting > 0 && (
                <span className="cut cut-chip game-waiting">
                  <Users aria-hidden="true" />
                  {waiting} waiting
                </span>
              )}
              <strong className="game-name">{g.name}</strong>
            </Link>
          );
        })}
      </div>
      {soon.length > 0 && (
        <div className="soon-strip">
          <b>
            <Clock aria-hidden="true" /> Coming soon
          </b>
          {soon.map((g) => (
            <span key={g.key} className="soon-item" aria-disabled="true">
              <span className="cut soon-thumb" aria-hidden="true">
                <Image src={g.tile} alt="" fill sizes="36px" />
              </span>
              {g.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
