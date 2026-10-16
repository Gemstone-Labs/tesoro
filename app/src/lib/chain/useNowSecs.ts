"use client";

import { useEffect, useState } from "react";

const nowSecs = () => Math.floor(Date.now() / 1000);

/** The clock in unix seconds, refreshed every `everyMs`, for views that show a Match's standing. */
export function useNowSecs(everyMs = 15_000): number {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
