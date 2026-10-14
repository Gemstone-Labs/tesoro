"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { MAX_EXTEND_LIMIT, type ExtendBlock, type ExtendLimitView } from "@/lib/chain/extend-limit";
import { fmtWhen } from "@/lib/format";

const at = (secs: number) => fmtWhen(secs * 1000);

/** The Extend button's label when it cannot be pressed, in plain words with the time to wait. */
export function blockedLabel(b: ExtendBlock): string {
  switch (b.kind) {
    case "waiting": return `Extend again ${at(b.until)}`;
    case "limit": return `Limit reached until ${at(b.until)}`;
    case "off": return "Extend is off";
    case "full": return "Already 12 months";
  }
}

function blockedNote(b: ExtendBlock, limit: number): string {
  switch (b.kind) {
    case "waiting": return `You extended recently. You can extend again ${at(b.until)}.`;
    case "limit": return `You have used your ${limit} ${limit === 1 ? "month" : "months"} for this period. You can extend again ${at(b.until)}.`;
    case "off": return "Extend is off because your limit is 0 months. Raise it below to use Extend.";
    case "full": return "This Advance already commits all 12 months, so there is nothing left to extend.";
  }
}

/** What this Advance commits, how much of the Extend Limit is used, why Extend may be waiting, and the control to change the limit. */
export function ExtendLimitPanel({ view, busy, error, onSet }: { view: ExtendLimitView; busy: boolean; error: string | null; onSet: (months: number) => void }) {
  const [pick, setPick] = useState(view.limit);
  const raising = pick > view.limit;
  const same = pick === view.limit && !view.pending;
  return (
    <div className="ext-limit">
      <p className="note"><b>{view.committed} of 12 months</b> are committed on this Advance.</p>
      <p className="note">
        Extend Limit: <b>{view.used} of {view.limit} {view.limit === 1 ? "month" : "months"}</b> used
        {view.resetsAt !== null ? <> · resets {at(view.resetsAt)}</> : " this 30-day period"}.
      </p>
      {view.pending && <p className="note">Your limit rises to {view.pending.months} {view.pending.months === 1 ? "month" : "months"} at {at(view.pending.at)}.</p>}
      {view.blocked && <p className="status" role="status">{blockedNote(view.blocked, view.limit)}</p>}
      <div className="field">
        <label className="label" htmlFor="ext-limit-pick">Change your limit</label>
        <div className="ext-limit-row">
          <span className="cut cut-chip ctl">
            <select id="ext-limit-pick" className="select" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
              {Array.from({ length: MAX_EXTEND_LIMIT + 1 }, (_, m) => (
                <option key={m} value={m}>{m} {m === 1 ? "month" : "months"}</option>
              ))}
            </select>
          </span>
          <Button size="sm" disabled={busy || same} onClick={() => onSet(pick)}>{busy ? "Saving…" : "Set limit"}</Button>
        </div>
        <p className="adv-fee">{same ? "Pick 0 to 11 months for every 30 days." : raising ? "A higher limit takes effect in 24 hours." : "A lower limit takes effect now."}</p>
        {error && <p className="status err" role="alert">{error}</p>}
      </div>
    </div>
  );
}
