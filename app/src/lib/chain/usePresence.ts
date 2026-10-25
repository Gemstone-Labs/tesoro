"use client";

import { useEffect } from "react";
import { useAccount } from "@/lib/account";
import { startPresenceLoop, touchPresence } from "./presence";

/** While `active`, touches the lease of the Player's open Queue Match now and every 15 s. Stops when inactive or unmounted. */
export function useQueuePresence(matchKey: string | null, active: boolean) {
  const { auth } = useAccount();
  const signer = auth.signer;
  const getToken = auth.getAccessToken;
  useEffect(() => {
    if (!matchKey || !active || !signer) return;
    return startPresenceLoop(() => touchPresence(signer, getToken, matchKey));
  }, [matchKey, active, signer, getToken]);
}
