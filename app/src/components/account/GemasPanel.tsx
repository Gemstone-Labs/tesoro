"use client";

import { useId, useMemo, useState } from "react";
import { CountUp, GemaMark, Label } from "@/components/ui";
import { gemasRecord, signed, type PlayedRow } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { RunningTotalChart } from "./RunningTotalChart";

/**
 * Gemas won and lost, after Fees: the net, won against lost as one split bar, and the running total.
 * With more than one game played, a game filter narrows all three to that game.
 */
export function GemasPanel({ rows }: { rows: PlayedRow[] }) {
  const [game, setGame] = useState<GameId | null>(null);
  const r = useMemo(() => gemasRecord(rows, game), [rows, game]);
  const group = useId();
  const n = r.series.length;
  const of = game ? ` of ${GAME_NAMES[game]}` : "";

  return (
    <section className="cut cut-card pa-panel pa-gemas" aria-label="Gemas won and lost">
      <div className="pa-gemas-top">
        <Label>Gemas won and lost</Label>
        {r.games.length > 1 && (
          <fieldset className="pa-filter">
            <legend className="sr-only">Game</legend>
            {[null, ...r.games].map((g) => (
              <label key={g ?? "all"} className="asset">
                <input type="radio" name={group} checked={game === g} onChange={() => setGame(g)} />
                <span className="cut cut-chip">{g ? GAME_NAMES[g] : "All games"}</span>
              </label>
            ))}
          </fieldset>
        )}
      </div>

      <div className="pa-net">
        <b className="pa-big">
          <GemaMark size={34} />
          <CountUp value={r.net} format={signed} duration={500} />
        </b>
        <p>{n === 0 ? `No Match${of} with a winner yet` : `Net after Fees, over ${n} ${n === 1 ? "Match" : "Matches"}${of}`}</p>
      </div>

      <div className="pa-split">
        <div className="pa-split-figs">
          <span>
            <small>
              Won · {r.wins} {r.wins === 1 ? "Match" : "Matches"}
            </small>
            <b className={r.won > 0 ? "pa-won" : undefined}>{signed(r.won)}</b>
          </span>
          <span>
            <small>
              Lost · {r.losses} {r.losses === 1 ? "Match" : "Matches"}
            </small>
            <b className={r.lost > 0 ? "pa-lost" : undefined}>{signed(-r.lost)}</b>
          </span>
        </div>
        <span className={`pa-split-bar${r.won + r.lost === 0 ? " none" : ""}`} aria-hidden="true">
          <i style={{ width: `${r.won + r.lost === 0 ? 0 : (r.won / (r.won + r.lost)) * 100}%` }} />
        </span>
      </div>

      {n >= 2 ? (
        <RunningTotalChart key={game ?? "all"} series={r.series} showGame={!game} />
      ) : (
        n === 1 && <p className="pa-chart-none">The running total shows from the second Match{of} with a winner.</p>
      )}
    </section>
  );
}
