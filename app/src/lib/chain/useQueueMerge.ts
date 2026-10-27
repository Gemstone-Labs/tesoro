"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { parseMatchKey } from "./match-id";
import { mergeIntoOlderMatch } from "./match-flow";
import { canMove } from "./queue";
import { fetchMatch } from "./read";

/** How often a waiting Player looks for an older Match. */
export const MERGE_EVERY_MS = 6_000;

export interface QueueMerge {
  /** "moving": the refund and join are under way; "failed": the Player was refunded or the fate is unknown (see `error`). */
  phase: "idle" | "moving" | "failed";
  error: string | null;
}

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
  const meKey = snapshot?.accountKey ?? null;
  const me = meKey?.toBase58() ?? null;
  // Keyed by Match: a new route starts idle without resetting in an effect.
  const [stored, setStored] = useState<QueueMerge & { matchId: string }>({ matchId, phase: "idle", error: null });
  const busy = useRef(false);

  useEffect(() => {
    if (!signer || !me || !parseMatchKey(matchId)) return;
    let live = true;

    const check = async () => {
      if (busy.current || document.visibilityState === "hidden") return;
      busy.current = true;
      try {
        const mine = await fetchMatch(matchId, meKey!);
        if (!live || !mine || !canMove(mine)) return;
        // One tab moves a Match: another tab of the same Player waits for the first to finish.
        const run = async () => {
          setStored({ matchId, phase: "moving", error: null });
          const merged = await mergeIntoOlderMatch(signer, getToken, mine);
          if (!merged.moved) setStored({ matchId, phase: "idle", error: null });
          // Only while the Player is still on this Match page: an effect re-run must not cancel a move that has happened.
          else if (window.location.pathname.endsWith(matchId)) router.replace(`/play/match/${merged.entered.id}`);
        };
        const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
        if (locks) await locks.request(`tesoro-queue-merge-${matchId}`, { ifAvailable: true }, async (lock) => (lock ? run() : undefined));
        else await run();
      } catch (e) {
        setStored({ matchId, phase: "failed", error: e instanceof Error ? e.message : "Something went wrong while moving you to an older Match." });
      } finally {
        busy.current = false;
      }
    };

    const timer = setInterval(() => void check(), MERGE_EVERY_MS);
    const first = setTimeout(() => void check(), 2_000);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [matchId, signer, getToken, me, meKey, router]);

  return stored.matchId === matchId ? stored : { phase: "idle", error: null };
}
