"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, type PointerEvent } from "react";
import { Clock, Users } from "lucide-react";
import { ENTRY_SIZES, GemaMark } from "@/components/ui";
import { CheckIcon, MinusIcon, XIcon } from "@/components/ui/icons";
import { useAccount } from "@/lib/account";
import { accountHistory } from "@/lib/chain/history";
import { gameFacts, waitingByEntry } from "@/lib/chain/lobby-plays";
import { CATALOGUE } from "@/lib/catalogue";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import { useQueue } from "./useQueue";

const RESULT_WORD = { won: ["Won", CheckIcon], lost: ["Lost", XIcon], draw: ["Draw", MinusIcon], refunded: ["Refunded", MinusIcon] } as const;

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

/**
 * GAMES: every live Game as an art tile that opens its page (entry, Play now). Phones: a 2×2 grid, the name and how many
 * Players wait. Desktop: two wide tiles a row with each entry and who waits at it, your last result and Practice free.
 */
export function GameGrid() {
  const queue = useQueue();
  const { auth, snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const facts = useMemo(
    () => (auth.status === "signed-in" && snapshot?.matchesLoaded ? gameFacts(accountHistory(snapshot.matches, snapshot.funded)) : {}),
    [auth.status, snapshot],
  );
  const live = CATALOGUE.filter((g) => g.live);
  const soon = CATALOGUE.filter((g) => !g.live);

  return (
    <section className="games" aria-labelledby="games-h">
      <h2 id="games-h" className="h-section">Games</h2>
      <div className="games-grid">
        {live.map((g, i) => {
          const byEntry = g.game && queue ? waitingByEntry(queue[g.game], ENTRY_SIZES, me) : {};
          const waiting = Object.values(byEntry).reduce((a, n) => a + n, 0);
          const fact = g.game ? facts[g.game] : undefined;
          const [word, Icon] = fact ? RESULT_WORD[fact.last] : [null, null];
          return (
            <div key={g.key} className="game-cell">
              <Link href={`/play/${g.game}`} className="cut cut-frame tile game-tile" onPointerMove={tilt} onPointerLeave={untilt}>
                <Image src={g.tile} alt="" fill sizes="(min-width: 1024px) 45vw, 50vw" loading={i < 2 ? "eager" : undefined} />
                <span className="tile-shade" aria-hidden="true" />
                <span className="tile-glare" aria-hidden="true" />
                {waiting > 0 && (
                  <span className="cut cut-chip game-waiting">
                    <Users aria-hidden="true" />
                    {waiting} waiting
                  </span>
                )}
                <span className="game-label">
                  <strong className="game-name">{g.name}</strong>
                  <span className="game-info">
                    {ENTRY_SIZES.map((e) => {
                      const n = byEntry[e] ?? 0;
                      return (
                        <span key={e} className={`cut cut-chip tile-entry${n > 0 ? " has" : ""}`} aria-label={`Entry ${fmtGemas(e)}${queue ? `, ${n} waiting` : ""}`}>
                          <GemaMark size={12} />
                          {fmtGemas(e)}
                          {n > 0 && <em>· {n} waiting</em>}
                        </span>
                      );
                    })}
                    {fact && Icon && (
                      <span className="tile-last">
                        <Icon aria-hidden="true" />
                        Last: {word}
                        {fact.best !== null && ` · Best ${fmtGemas(fact.best)}`}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
              {g.game && (
                <Link href={practiceHref(g.game)} className="cut cut-chip game-practice">
                  Practice free
                </Link>
              )}
            </div>
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
