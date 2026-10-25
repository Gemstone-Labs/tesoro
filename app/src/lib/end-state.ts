"use client";

import { useEffect, useState } from "react";
import type { EndState } from "@/server/history/end-state";

/** `loading` until the answer is in; `none` when no end state was kept (or the history cannot be reached). It never stays `loading`. */
export type EndStateRead = { status: "loading" } | { status: "none" } | { status: "found"; state: EndState };

const WAIT_MS = 8000;

/** Reads a finished table Match's public end state from the Match history. Turns off with `enabled=false` (say, while the table still holds the Match). */
export function useEndState(matchAddress: string, enabled: boolean, game: EndState["game"]): EndStateRead {
  const key = `${matchAddress}:${game}`;
  const [answer, setAnswer] = useState<{ key: string; read: EndStateRead } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ctl = new AbortController();
    const stop = setTimeout(() => ctl.abort(), WAIT_MS);
    fetch(`/api/end-state/${matchAddress}`, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) return { status: "none" } as const;
        const body = (await res.json()) as { state?: EndState };
        return body.state && body.state.game === game ? ({ status: "found", state: body.state } as const) : ({ status: "none" } as const);
      })
      .catch(() => ({ status: "none" }) as const)
      .then((r) => {
        clearTimeout(stop);
        if (live) setAnswer({ key, read: r });
      });
    return () => {
      live = false;
      clearTimeout(stop);
      ctl.abort();
    };
  }, [matchAddress, enabled, game, key]);
  return answer && answer.key === key ? answer.read : { status: "loading" };
}
