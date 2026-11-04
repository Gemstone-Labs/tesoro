"use client";

import { useEffect } from "react";
import { useAccount } from "@/lib/account";
import { useMatchSigner } from "@/lib/seat/useMatchSigner";
import { keepScreenAwake, startPresenceLoop, touchPresence } from "./presence";

/** While `active`, touches the lease of the Player's open Queue Match now, every 15 s and on return to the page, and keeps the screen on. Stops when inactive or unmounted. */
export function useQueuePresence(matchKey: string | null, active: boolean) {
  const { auth } = useAccount();
  const { signer } = useMatchSigner(matchKey);
  const getToken = auth.getAccessToken;
  useEffect(() => {
    if (!matchKey || !active || !signer) return;
    const stopTouching = startPresenceLoop(() => touchPresence(signer, getToken, matchKey));
    const letGo = keepScreenAwake();
    return () => {
      stopTouching();
      letGo();
    };
  }, [matchKey, active, signer, getToken]);
}
