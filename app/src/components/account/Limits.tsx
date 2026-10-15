"use client";

import { useState } from "react";
import { ExtendLimitPanel } from "@/app/(app)/wallet/ExtendLimit";
import { Button } from "@/components/ui";
import { entryLimitChange, entryLimitOptions, entryLimitSummary, entryPendingNote, type EntryLimitView } from "@/lib/chain/entry-limit";
import type { ExtendLimitView } from "@/lib/chain/extend-limit";
import "./account.css";

export interface LimitsViewProps {
  /** Null while the Entry Limit loads. */
  entry: EntryLimitView | null;
  /** Null while the Extend Limit loads. */
  extend: ExtendLimitView | null;
  /** The action that is running ("entry" or "extend"), if any. */
  busy: string | null;
  error: string | null;
  onSetEntry: (gemas: number) => void;
  onSetExtend: (months: number) => void;
  onRetry: () => void;
}

const CHANGE_NOTE = {
  same: "Pick the most Gemas you want to enter into Matches in any 7 days.",
  raise: "A higher limit, or no limit, takes effect in 24 hours.",
  lower: "A lower limit takes effect now.",
  cancel: "This keeps your current limit and cancels the raise.",
} as const;

/** The Limits screen: the Entry Limit and the Extend Limit together, what is in force and what is waiting. */
export function LimitsView({ entry, extend, busy, error, onSetEntry, onSetExtend, onRetry }: LimitsViewProps) {
  return (
    <div className="stack lim">
      <section className="stack" aria-labelledby="lim-entry-h">
        <h3 id="lim-entry-h" className="label">Entry Limit</h3>
        <p className="note">The most Gemas you can enter into Matches in any 7 days, including Backings you fund. Matches a Backer funds for you do not count.</p>
        {entry === null ? (
          <p className="meta" role="status">Loading…</p>
        ) : (
          <EntryLimitControl view={entry} busy={busy === "entry"} onSet={onSetEntry} />
        )}
      </section>
      <section className="stack" aria-labelledby="lim-extend-h">
        <h3 id="lim-extend-h" className="label">Extend Limit</h3>
        {extend === null ? (
          <p className="meta" role="status">Loading…</p>
        ) : (
          <ExtendLimitPanel view={extend} busy={busy === "extend"} error={null} onRetry={onRetry} onSet={onSetExtend} showCommitted={false} />
        )}
      </section>
      {error && <p className="status err" role="alert">{error}</p>}
    </div>
  );
}

function EntryLimitControl({ view, busy, onSet }: { view: EntryLimitView; busy: boolean; onSet: (gemas: number) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const pick = picked ?? view.limit ?? 0;
  const change = entryLimitChange(view, pick);
  return (
    <div className="ext-limit">
      <p className="note"><b>{entryLimitSummary(view)}</b></p>
      {view.pending && <p className="note">{entryPendingNote(view.pending)}</p>}
      <div className="field">
        <label className="label" htmlFor="entry-limit-pick">Change your limit</label>
        <div className="ext-limit-row">
          <span className="cut cut-chip ctl">
            <select id="entry-limit-pick" className="select" value={pick} onChange={(e) => setPicked(Number(e.target.value))}>
              {entryLimitOptions(view).map((g) => (
                <option key={g} value={g}>{g === 0 ? "No limit" : `${g.toLocaleString("en-US")} Gemas`}</option>
              ))}
            </select>
          </span>
          <Button size="sm" disabled={busy || change === "same"} onClick={() => { onSet(pick); setPicked(null); }}>{busy ? "Saving…" : "Set limit"}</Button>
        </div>
        <p className="adv-fee">{CHANGE_NOTE[change]}</p>
      </div>
    </div>
  );
}
