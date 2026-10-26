"use client";

import Image from "next/image";
import Link from "next/link";
import { GemaMark } from "@/components/ui";
import { art } from "@/lib/art";
import type { ChainRequest } from "@/lib/chain/backing";
import type { PlayerSummary } from "@/lib/chain/player-account";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_SHORT } from "@/lib/friends/words";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const rate = (wins: number, of: number) => Math.round((wins / of) * 100);

interface Props {
  s: PlayerSummary;
  /** The games to list, from `topGames`. */
  games: { game: GameId; matches: number; wins: number }[];
  now: number;
  visitor: boolean;
  requests: ChainRequest[];
}

/**
 * The facts between the name and the buttons: Record and Win rate as two big figures in one ruled row, when the Player started, and the
 * (at most three) games they play most with their W–L. A new Account shows nothing here; Backing shows only while the Player is asking.
 */
export function AccountFacts({ s, games, now, visitor, requests }: Props) {
  const ask = requests[0];
  const played = s.first !== null;
  if (!played && !ask) return null;
  const { matches, wins } = s.record;
  return (
    <div className="pa-facts">
      {played && (
        <>
          <dl className="pa-big2">
            <div>
              <dt>Record</dt>
              <dd>{matches ? `${wins} of ${matches}` : "None yet"}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{matches ? `${rate(wins, matches)}%` : "None yet"}</dd>
            </div>
          </dl>
          <p className="pa-since">Playing since {day(s.first!)}</p>
          {games.length > 0 && (
            <ul className="pa-gl">
              {games.map((g) => (
                <li key={g.game}>
                  <Image src={art.thumb[g.game]} alt="" width={32} height={32} />
                  <span>{GAME_NAMES[g.game]}</span>
                  <b>
                    {g.wins}–{g.matches - g.wins}
                  </b>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {ask && (
        <p className="cut cut-card pa-ask-row">
          <span>
            <b>Asking to be backed</b>
            <span className="pa-ask-meta">
              <GemaMark size={14} />
              {fmtGemas(ask.entry)} · {GAME_SHORT[ask.game]} · {timeLeft(ask.expiresAt, now).replace(" left", "")} left
            </span>
          </span>
          <Link href={`/backing#${ask.address.toBase58()}`}>{visitor ? "Make an Offer" : "See Request"}</Link>
        </p>
      )}
    </div>
  );
}
