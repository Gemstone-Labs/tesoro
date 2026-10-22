/**
 * The entry draw, as tesoro_core `Pool::plan_draw` / `draw_direct` do it, for the preview and for
 * choosing between a direct draw and a Ticket. The preview equals the program's draw: same merged
 * order of basket and spill (own first, then won; within a side the earliest planned repayment
 * first, i.e. the fastest Gemas; ties by Source), fee classes never drawn.
 */

import type { PublicKey } from "@solana/web3.js";
import { bookPda, ckptPda, compareKeys, freeGemas, MAX_DIRECT_LINES, mergedLines, type Line, type LineKey, type Store } from "./basket";
import { CLASS_GENERAL, CLASS_LEADERBOARD, CLASS_PLATFORM } from "./basket";

export interface DrawStep {
  key: LineKey;
  line: Line;
  /** Gemas taken from the line. */
  take: bigint;
  /** The entry takes the whole line (it moves without touching its Source's book). */
  whole: boolean;
}

export type DrawProblem = "zero" | "insufficient";

export interface DrawPlan {
  steps: DrawStep[];
  /** Gemas the entry takes. */
  total: bigint;
  /** More lines than one transaction draws: the entry needs a Ticket (`open_ticket` + `stage_entry`). */
  needsTicket: boolean;
  /** `pot_lines` for a direct `open_match` / `join_match`: distinct lines the Pot receives. */
  potLines: number;
  /** Free Gemas before the draw. */
  free: bigint;
}

/** The draw of `amount` Gemas over both stores. Throws `DrawError` when it cannot be made. */
export class DrawError extends Error {
  constructor(readonly code: DrawProblem) {
    super(code === "zero" ? "An entry needs at least 1 Gema" : "Not enough free Gemas for this entry");
  }
}

/**
 * `limit` defaults to the free Gemas (playable minus Offer reservations minus a Ticket's need). A
 * Backing draw passes a higher limit (it may use what its own Offer reserved).
 */
export function planDraw(basket: Store, spill: Store | null, amount: bigint, limit?: bigint): DrawPlan {
  if (amount <= 0n) throw new DrawError("zero");
  const free = freeGemas(basket, spill);
  if (amount > (limit ?? free)) throw new DrawError("insufficient");
  const steps: DrawStep[] = [];
  let left = amount;
  for (const line of mergedLines(basket, spill)) {
    if (left === 0n) break;
    if (line.classId < CLASS_GENERAL || line.amount === 0n) continue;
    const take = line.amount < left ? line.amount : left;
    steps.push({ key: line, line, take, whole: take === line.amount });
    left -= take;
  }
  if (left > 0n) throw new DrawError("insufficient");
  // a basket line and a spill line of one key arrive in the Pot as one line
  const distinct = new Set(steps.map((s) => keyId(s.key)));
  return { steps, total: amount, needsTicket: steps.length > MAX_DIRECT_LINES, potLines: distinct.size, free };
}

const keyId = (k: LineKey) => `${k.side}:${k.dueAt}:${k.source.toBase58()}:${k.classId}:${k.tranche}`;

/** Why an entry cannot be made, or null. */
export function entryProblem(basket: Store, spill: Store | null, amount: bigint): DrawProblem | null {
  try {
    planDraw(basket, spill, amount);
    return null;
  } catch (e) {
    if (e instanceof DrawError) return e.code;
    throw e;
  }
}

/** Distinct Sources whose book the draw touches: a split line (the one the entry only part-takes) and any merge of a basket and a spill line. */
export function sourcesTouched(plan: DrawPlan): PublicKey[] {
  const out = new Map<string, PublicKey>();
  const seen = new Map<string, number>();
  for (const s of plan.steps) {
    const id = keyId(s.key);
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (!s.whole || (seen.get(id) ?? 0) > 1) out.set(s.key.source.toBase58(), s.key.source);
  }
  return [...out.values()];
}

/**
 * The checkpoint pages a line's catch-up reads: records `line.ck ..` of its class, at most 11
 * (`MAX_CATCHUP_SCALE_STEPS + 1`), and only those that exist (index < class.ck).
 */
export function ckptPagesFor(source: PublicKey, classId: number, lineCk: number, classCk: number): PublicKey[] {
  const pages = new Set<number>();
  for (let i = lineCk; i < Math.min(classCk, lineCk + 11); i++) pages.add(Math.floor(i / 32));
  return [...pages].map((p) => ckptPda(source, classId, p));
}

/** The remaining accounts for one touched Source: its book, then the pages its stale lines need. Fee classes write no records. */
export function bookAccounts(source: PublicKey, lines: Line[], classCk: (classId: number) => number): PublicKey[] {
  const keys = new Map<string, PublicKey>([[bookPda(source).toBase58(), bookPda(source)]]);
  for (const l of lines) {
    if (l.classId === CLASS_PLATFORM || l.classId === CLASS_LEADERBOARD) continue; // pooled classes write no records
    for (const k of ckptPagesFor(source, l.classId, l.ck, classCk(l.classId))) keys.set(k.toBase58(), k);
  }
  return [...keys.values()];
}

export { compareKeys };
