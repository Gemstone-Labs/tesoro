// Storybook: the Leaderboard Pool comes from the story (`parameters.screen.pool`), never from the RPC websocket.
import { useEffect, useState } from "react";
import { screenData } from "../../../../../stories/screens/support/screen";

export function usePool(): number | null {
  const { gemas = 12_480, growMs } = screenData().pool ?? {};
  const [pool, setPool] = useState(gemas);
  const shown = gemas != null;
  useEffect(() => {
    if (!growMs || !shown) return;
    const t = setInterval(() => setPool((n) => (n ?? 0) + 10 * (1 + Math.floor(Math.random() * 5))), growMs);
    return () => clearInterval(t);
  }, [growMs, shown]);
  return pool;
}
