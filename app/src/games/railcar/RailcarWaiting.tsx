"use client";

import type { PublicKey } from "@solana/web3.js";
import { WaitingForMatch } from "@/app/(app)/wallet/WaitingForRoom";

/** The Gemas this car's ride left waiting for room (nothing before the car is known or when none wait). */
export function RailcarWaiting({ match }: { match: PublicKey | null }) {
  return match ? <WaitingForMatch match={match} /> : null;
}
