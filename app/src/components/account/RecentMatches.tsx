"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { signed, type PlayedRow } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";

const WORD = { won: "Won", lost: "Lost", draw: "Draw", "no-show": "No-show", refunded: "Refunded" } as const;
/** How many Matches the Account page lists before "See all". */
export const RECENT = 3;

/** The latest Matches as slim rows: result, game, opponent, Gemas and age. "See all" opens the full history. */
export function RecentMatches({ rows, now, allHref, onAll }: { rows: PlayedRow[]; now: number; allHref?: string; onAll?: () => void }) {
  return (
    <section className="cut cut-card pa-recent" aria-labelledby="pa-recent-h">
      <header>
        <h2 id="pa-recent-h" className="pa-lab">Recent Matches</h2>
        {(rows.length > RECENT || allHref) &&
          (allHref ? (
            <Link href={allHref} className="pa-all">
              See all <ChevronRight aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" className="pa-all" onClick={onAll}>
              See all <ChevronRight aria-hidden="true" />
            </button>
          ))}
      </header>
      {rows.length === 0 ? (
        <p className="pa-none">No finished Matches yet.</p>
      ) : (
        <ul>
          {rows.slice(0, RECENT).map((r) => (
            <li key={r.id}>
              <RecentRow r={r} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRow({ r, now }: { r: PlayedRow; now: number }) {
  const opp = usePlayerLabel(r.opp);
  return (
    <Link href={`/play/match/${r.id}`} className="pa-recent-row">
      <span className={`cut cut-chip pa-res ${r.result}`}>{WORD[r.result]}</span>
      <Image className="pa-recent-game" src={art.thumb[r.game]} alt="" width={40} height={40} />
      <span className="pa-recent-who">
        <b>{GAME_NAMES[r.game]}</b>
        {r.opp && <small>vs {opp}</small>}
      </span>
      {r.opp && (
        <span className="cut cut-btn avatar pa-recent-opp">
          <PlayerAvatar account={r.opp} size={40} />
        </span>
      )}
      <span className={`pa-recent-delta${r.delta > 0 ? " won" : r.delta < 0 ? " lost" : ""}`}>
        <GemaMark size={14} />
        {signed(r.delta)}
      </span>
      <time>{ago(r.at, now).replace(" ago", "")}</time>
    </Link>
  );
}
