"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { MAX_EXTEND_LIMIT, blockedNote, extendLimitChange, type ExtendLimitView } from "@/lib/chain/extend-limit";
import { fmtWhen } from "@/lib/format";

const at = (secs: number) => fmtWhen(secs * 1000);

/** What this Advance commits, how much of the Extend Limit is used, why Extend may be waiting, and the control to change the limit. */
export function ExtendLimitPanel({ view, busy, error, onSet, onRetry }: { view: ExtendLimitView; busy: boolean; error: string | null; onSet: (months: number) => void; onRetry: () => void }) {
  // Until the Player picks, the select shows the limit in force, whenever it was read.
  const [picked, setPicked] = useState<number | null>(null);
  const pick = picked ?? view.limit;
  const change = extendLimitChange(view, pick);
  const unknown = view.blocked?.kind === "unknown";
  return (
    <div className="ext-limit">
      <p className="note"><b>{view.committed} of 12 months</b> are committed on this Advance.</p>
      {!unknown && <p className="note">
        Extend Limit: <b>{view.used} of {view.limit} {view.limit === 1 ? "month" : "months"}</b> used
        {view.resetsAt !== null ? <> · resets {at(view.resetsAt)}</> : " this 30-day period"}.
      </p>}
      {!unknown && view.pending && <p className="note">Your limit rises to {view.pending.months} {view.pending.months === 1 ? "month" : "months"} at {at(view.pending.at)}.</p>}
      {view.blocked && (
        <p className="status" role="status">
          {blockedNote(view.blocked, view.limit)}
        </p>
      )}
      {unknown && <Button size="sm" onClick={onRetry}>Retry</Button>}
      <div className="field">
        <label className="label" htmlFor="ext-limit-pick">Change your limit</label>
        <div className="ext-limit-row">
          <span className="cut cut-chip ctl">
            <select id="ext-limit-pick" className="select" value={pick} onChange={(e) => setPicked(Number(e.target.value))}>
              {Array.from({ length: MAX_EXTEND_LIMIT + 1 }, (_, m) => (
                <option key={m} value={m}>{m} {m === 1 ? "month" : "months"}</option>
              ))}
            </select>
          </span>
          <Button size="sm" disabled={busy || unknown || change === "same"} onClick={() => { onSet(pick); setPicked(null); }}>{busy ? "Saving…" : "Set limit"}</Button>
        </div>
        <p className="adv-fee">{{ same: "Pick 0 to 11 months for every 30 days.", raise: "A higher limit takes effect in 24 hours.", lower: "A lower limit takes effect now.", cancel: "This keeps your current limit and cancels the raise." }[change]}</p>
        {error && <p className="status err" role="alert">{error}</p>}
      </div>
    </div>
  );
}
