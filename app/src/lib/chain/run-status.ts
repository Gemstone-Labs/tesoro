import type { ChainMatch } from "./read";
import { refundByText } from "./match-status";
import type { RunStage } from "./match-flow";

type Input = Pick<ChainMatch, "status" | "game" | "seat" | "deadline"> & {
  session: Pick<NonNullable<ChainMatch["session"]>, "settled" | "joined" | "openerDeadline" | "deadline"> | null;
};

/**
 * The window left to begin this Player's Block Burst run, or null when there is nothing to play.
 * The base layer cannot tell whether a run began (the Board lives in the rollup), so the caller
 * passes the probed `stage`; an unknown stage claims nothing.
 */
export function unplayedRun(m: Input, nowSecs: number, stage: RunStage | undefined): { playBy: number } | null {
  if (m.game !== "block-puzzle" || !m.session || m.session.settled || m.seat === null) return null;
  if (m.status !== "open" && m.status !== "active") return null;
  if (stage !== "needs-prep" && stage !== "ready") return null;
  const playBy = m.seat === 0 ? m.session.openerDeadline : m.session.joined ? m.session.deadline : m.deadline;
  return nowSecs < playBy ? { playBy } : null;
}

/** One line for the Continue card. */
export function playRunLine(u: { playBy: number }, nowMs: number): string {
  return `Play your run · closes at ${refundByText(u.playBy, nowMs)}`;
}
