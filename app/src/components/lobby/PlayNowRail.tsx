"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, type PointerEvent } from "react";
import { ArrowRight, Clock, X } from "lucide-react";
import { ENTRY_SIZES, GemaMark } from "@/components/ui";
import { CheckIcon, MinusIcon, XIcon } from "@/components/ui/icons";
import { useAccount } from "@/lib/account";
import { accountHistory } from "@/lib/chain/history";
import { gameFacts, waitingByEntry } from "@/lib/chain/lobby-plays";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import type { GameId } from "@/lib/mock/types";
import { CATALOGUE } from "@/lib/catalogue";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";
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

/** PLAY NOW: the live Games as large tiles, the announced ones as one quiet strip. Search filters it. */
export function PlayNowRail() {
  const { query, setQuery } = useSearch();
  const queue = useQueue();
  const { auth, snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const facts = useMemo(
    () => (auth.status === "signed-in" && snapshot?.matchesLoaded ? gameFacts(accountHistory(snapshot.matches, snapshot.funded)) : {}),
    [auth.status, snapshot],
  );
  const matches = CATALOGUE.filter((g) => !query.trim() || matchesQuery(g.name, query));
  const live = matches.filter((g) => g.live);
  const tiles = live.length;
  const soon = matches.filter((g) => !g.live);
  const filtering = Boolean(query.trim());

  return (
    <Rail
      id="play-now"
      title={filtering ? "Search results" : "Play now"}
      cols={2}
      aside={
        filtering && (
          <span className="filter-note">
            “{query.trim()}”
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
              <X aria-hidden="true" />
            </button>
          </span>
        )
      }
    >
      {matches.length === 0 && <p className="rail-empty">No games match. Clear the search to see every game.</p>}
      {live.map((g, i) => (
        <div key={g.key} className={`tile-cell${i === tiles - 1 && tiles % 2 === 1 ? " last-odd" : ""}`}>
          <Link href={`/play/${g.game}`} className="cut cut-frame tile" onPointerMove={tilt} onPointerLeave={untilt}>
            <Image src={g.tile} alt="" fill sizes="(min-width: 1024px) 40vw, 100vw" />
            <span className="tile-shade" aria-hidden="true" />
            <span className="tile-glare" aria-hidden="true" />
            <span className="cut cut-chip tile-live">
              <i className="live-dot" aria-hidden="true" />
              Live now
            </span>
            <span className="tile-label">
              <strong>{g.name}</strong>
              {g.game && <TileInfo waiting={waitingByEntry(queue?.[g.game], ENTRY_SIZES, me)} loaded={queue !== null} fact={facts[g.game]} />}
            </span>
          </Link>
          {g.game && (
            <div className="tile-actions">
              <Link href={`/play/${g.game}`} className="cut cut-btn btn money tile-play">
                Play now <ArrowRight aria-hidden="true" />
              </Link>
              <Link href={practiceHref(g.game)} className="cut cut-chip tile-practice">
                Practice free
              </Link>
            </div>
          )}
        </div>
      ))}
      {soon.length > 0 && (
        <div className="soon-strip" style={{ gridColumn: "1 / -1" }}>
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
    </Rail>
  );
}

/** What the hero does not say: each entry with the Players waiting at it, and the Player's own last result or best score. */
function TileInfo({ waiting, loaded, fact }: { waiting: Record<number, number>; loaded: boolean; fact?: ReturnType<typeof gameFacts>[GameId] }) {
  const [word, Icon] = fact ? RESULT_WORD[fact.last] : [null, null];
  return (
    <span className="tile-info">
      {ENTRY_SIZES.map((e) => {
        const n = waiting[e] ?? 0;
        return (
          <span key={e} className={`cut cut-chip tile-entry${n > 0 ? " has" : ""}`} aria-label={`Entry ${fmtGemas(e)}${loaded ? `, ${n} waiting` : ""}`}>
            <GemaMark size={12} />
            {fmtGemas(e)}
            {loaded && n > 0 && <em>· {n} waiting</em>}
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
  );
}
