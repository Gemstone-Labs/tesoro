"use client";

import { Meter } from "@/components/ui";
import type { StagedEntry } from "@/lib/chain/ticket";
import { fmtGemas } from "@/lib/format";

/** For an entry put together in steps: how far along it is. Nothing for an entry made in one go. */
export function EntryPlan({ staged = null }: { staged?: StagedEntry | null }) {
  if (!staged) return null;
  return (
    <div className="enter-plan" aria-label="Entry progress">
      <div className="enter-plan-staged" role="status">
        <Meter value={staged.progress} label="Entry prepared" />
        <p className="meta">
          Preparing your entry: <b className="tnum">{fmtGemas(Number(staged.staged))}</b> of <b className="tnum">{fmtGemas(Number(staged.target))}</b> Gemas ready.
          {staged.complete ? " Opening your Match…" : staged.stepsLeft > 0 ? ` About ${staged.stepsLeft} more ${staged.stepsLeft === 1 ? "step" : "steps"}.` : ""}
        </p>
        {!staged.complete && <p className="meta">Keep this page open. If you leave, your Gemas stay in your Account and the entry can be finished or cancelled later.</p>}
      </div>
    </div>
  );
}
