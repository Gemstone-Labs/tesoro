"use client";

import { PublicKey } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { parseMatchKey } from "./match-id";
import { mergeIntoOlderMatch } from "./match-flow";
import { checkForOlder, type QueueMerge } from "./merge-check";
import { fetchMatch } from "./read";

export type { QueueMerge };

/** How often a waiting Player looks for an older Match. */
export const MERGE_EVERY_MS = 6_000;

/**
 * While the Player sits alone in a Queue Match, looks for an older open Match at the same entry and moves into it (see
 * `mergeQueue`). The younger of two waiting openers moves, the older one never does. Challenges and Backed entries never move.
 * Moving replaces the route with the Match joined, or leaves the page alone when nothing changed.
 */
export function useQueueMerge(matchId: string): QueueMerge {
  const { auth, snapshot } = useAccount();
  const router = useRouter();
  const signer = auth.signer;
  const getToken = auth.getAccessToken;
  const me = snapshot?.accountKey.toBase58() ?? null;
  // Keyed by Match: a new route starts idle without resetting in an effect.
  const [stored, setStored] = useState<QueueMerge & { matchId: string }>({ matchId, phase: "idle", error: null });
  const busy = useRef(false);

  useEffect(() => {
    if (!signer || !me || !parseMatchKey(matchId)) return;
    const meKey = new PublicKey(me);
    let over = false;

    const check = async () => {
      if (over || busy.current || document.visibilityState === "hidden") return;
      busy.current = true;
      try {
        // One tab moves a Match: another tab of the same Player waits for the first to finish.
        const run = async () => {
          if ((await look()) === "over") stop();
        };
        const look = () =>
          checkForOlder({
            fetchMine: () => fetchMatch(matchId, meKey),
            merge: (mine, on) => mergeIntoOlderMatch(signer, getToken, mine, on),
            set: (s) => setStored({ matchId, ...s }),
            navigate: (id) => router.replace(`/play/match/${id}`),
            // An effect re-run must not cancel a move that has happened; only a Player who left stays where they went.
            stillHere: () => window.location.pathname.endsWith(matchId),
          });
        const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
        if (locks) await locks.request(`tesoro-queue-merge-${matchId}`, { ifAvailable: true }, async (lock) => (lock ? run() : undefined));
        else await run();
      } finally {
        busy.current = false;
      }
    };

    const timer = setInterval(() => void check(), MERGE_EVERY_MS);
    const first = setTimeout(() => void check(), 2_000);
    const stop = () => {
      over = true;
      clearInterval(timer);
      clearTimeout(first);
    };
    return stop;
  }, [matchId, signer, getToken, me, router]);

  return stored.matchId === matchId ? stored : { phase: "idle", error: null };
}
