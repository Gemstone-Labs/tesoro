"use client";

import { useId, useMemo, useState } from "react";
import { CountUp, GemaMark, Label } from "@/components/ui";
import { gemasRecord, signed, type PlayedRow } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { RunningTotalChart } from "./RunningTotalChart";
import { FilterMenu, FilterNow, FilterRail, FilterSwitcher, FilterTabs, FilterTiles, useFilterVariant } from "./GameFilter.prototype";

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
  // PROTOTYPE: ?variant=now|A|B|C|D picks the game filter
  const variant = useFilterVariant();
  const stats = useMemo(() => {
    const all = gemasRecord(rows, null);
    const m = new Map<GameId | "all", { net: number; n: number }>([["all", { net: all.net, n: all.series.length }]]);
    for (const g of all.games) {
      const x = gemasRecord(rows, g);
      m.set(g, { net: x.net, n: x.series.length });
    }
    return m;
  }, [rows]);
  const multi = r.games.length > 1;
  const fp = { games: r.games, value: game, onChange: setGame, stats, group };

  return (
    <section className="cut cut-card pa-panel pa-gemas" aria-label="Gemas won and lost">
      <div className="pa-gemas-top">
        <Label>Gemas won and lost</Label>
        {multi && variant === "now" && <FilterNow {...fp} />}
        {multi && variant === "A" && <FilterRail {...fp} />}
        {multi && variant === "D" && <FilterMenu {...fp} />}
      </div>

      {multi && variant === "B" && (
        <div className="gf-tabs-row">
          <FilterTabs {...fp} />
        </div>
      )}
      {multi && variant === "C" && <FilterTiles {...fp} />}
      <FilterSwitcher />

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
