// Storybook: the Leaderboard Pool comes from the story (`parameters.screen.pool`), else the story's leaderboard, never from the RPC websocket.
import { useEffect, useState } from "react";
import { leaderboardView, screenData } from "../../../../../stories/screens/support/screen";

function initial(): number | null {
  const { pool, leaderboard = "live" } = screenData();
  if (pool) return pool.gemas;
  return leaderboard === "loading" || leaderboard === "error" ? null : leaderboardView(leaderboard).poolGemas;
}

export function usePool(): number | null {
  const growMs = screenData().pool?.growMs;
  const [pool, setPool] = useState(initial);
  const shown = pool != null;
  useEffect(() => {
    if (!growMs || !shown) return;
    const t = setInterval(() => setPool((n) => (n ?? 0) + 10 * (1 + Math.floor(Math.random() * 5))), growMs);
    return () => clearInterval(t);
  }, [growMs, shown]);
  return pool;
}
