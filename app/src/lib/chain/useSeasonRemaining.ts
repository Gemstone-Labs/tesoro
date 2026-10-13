import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2d 04h 13m" with days, else "04h 13m 09s". */
export function left(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s % 60)}s`;
}

/** Seconds until `end` on the server's clock (`serverNow`), ticking; null until mounted. */
export function useSeasonRemaining(serverNow: number | undefined, end: number | undefined): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (serverNow === undefined) return;
    const offset = serverNow - Date.now() / 1000;
    const tick = () => setNow(Date.now() / 1000 + offset);
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [serverNow]);
  return now === null || end === undefined ? null : end - now;
}
