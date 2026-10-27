import { CANCELLING_NOTE, NO_TABLE_NOTE } from "./match-status";

/**
 * Where a Match is in its life, in order. The page derives its stage from several reads (the base-layer Match, the
 * rollup's Table, the Assignment) that arrive late, fail for a moment, or disappear once the Match closes. A read that
 * is missing must never move the screen back: once a later stage has been shown, an earlier one is not.
 */
const RANK: Record<string, number> = {
  waiting: 1,
  table: 2,
  cancelling: 2,
  setup: 3,
  getReady: 4,
  playing: 5,
  live: 5,
  closing: 6,
  settled: 7,
};

/** The rank of a stage; `setup` with the no-table or cancelling note is still the table wait. Null for stages outside the life (loading, spectator, backer, notfound). */
export function stageRank(stage: string, note = ""): number | null {
  if (stage === "setup" && (note === NO_TABLE_NOTE || note === CANCELLING_NOTE)) return RANK.table;
  return RANK[stage] ?? null;
}

export interface MatchProgress<M, S extends string> {
  /** The Match this tracker belongs to. */
  readonly id: string | null;
  /** The Match to show: the fresh read, or the last one seen when the fresh read found nothing (a closed Match is not in the history yet). */
  match(fresh: M | null): M | null;
  /** The stage to show: `next`, unless it is behind a stage already shown. `held` is true when it was refused. */
  stage(next: S, note?: string): { stage: S; note: string; held: boolean };
}

/** One tracker per Match page; build a new one when the Match id changes. */
export function matchProgress<M, S extends string>(id: string | null): MatchProgress<M, S> {
  let known: M | null = null;
  let shown: { stage: S; note: string; rank: number } | null = null;
  return {
    id,
    match(fresh) {
      if (fresh) known = fresh;
      return fresh ?? known;
    },
    stage(next, note = "") {
      const rank = stageRank(next, note);
      if (shown && shown.rank > (rank ?? 0) && (rank !== null || next === "notfound")) return { stage: shown.stage, note: shown.note, held: true };
      if (rank !== null) shown = { stage: next, note, rank };
      return { stage: next, note, held: false };
    },
  };
}
