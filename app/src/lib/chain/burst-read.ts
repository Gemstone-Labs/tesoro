import type { PublicKey } from "@solana/web3.js";
import { OUTCOME, runLogOf, slotOf, type RunLog, type Slot, type Table } from "@/games/block-puzzle/live-chain";
import { getBurst } from "./client";

/** What a finished Block Burst Match shows besides its winner: the scores and the Seed, public once the Match is over. */
export interface BurstSession {
  settled: boolean;
  result: "opener" | "joiner" | "draw";
  scores: [number, number];
  seed: bigint;
}

/**
 * The result of a Match from its ring slot and run log. Seat 0 opened the tesoro_core Match. A refund (no-show, void, no Seed,
 * nobody checked in) has no scores to show, so it is `null`.
 */
export function sessionFromLog(slot: Slot | null, log: RunLog | null): BurstSession | null {
  if (!slot || !log) return null;
  const result = slot.outcome === OUTCOME.win0 ? "opener" : slot.outcome === OUTCOME.win1 ? "joiner" : slot.outcome === OUTCOME.draw ? "draw" : null;
  return result ? { settled: true, result, scores: [log.scores[0], log.scores[1]], seed: log.seed } : null;
}

/** The result of `match` as the committed table on the base layer still holds it (it is dropped when the ring slot is freed). */
export function sessionFromTable(t: Table | null, match: PublicKey, epoch: number): BurstSession | null {
  return t ? sessionFromLog(slotOf(t, match, epoch), runLogOf(t, match, epoch)) : null;
}

export async function burstSession(match: PublicKey): Promise<BurstSession | null> {
  const burst = getBurst();
  const a = await burst.readAssignment(match).catch(() => null);
  if (!a) return null;
  return sessionFromTable(await burst.readTableOnBase(a).catch(() => null), match, a.epoch);
}
