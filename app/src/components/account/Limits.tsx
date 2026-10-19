"use client";

import { useState } from "react";
import { ExtendLimitPanel } from "@/app/(app)/wallet/ExtendLimit";
import { Button } from "@/components/ui";
import { fmtWhen } from "@/lib/format";
import { entryLimitChange, entryLimitOptions, entryLimitSummary, entryPendingNote, type EntryLimitView } from "@/lib/chain/entry-limit";
import type { ExtendLimitView } from "@/lib/chain/extend-limit";
import {
  breakEnd,
  breakLabel,
  breakOptions,
  confirmText,
  selfExclusionEnd,
  selfExclusionLabel,
  selfExclusionOptions,
  awayNotice,
  type AwayView,
} from "@/lib/chain/protections";
import "./account.css";

export interface LimitsViewProps {
  /** Null while the Entry Limit loads. */
  entry: EntryLimitView | null;
  /** Null while the Extend Limit loads. */
  extend: ExtendLimitView | null;
  /** Null while the Break and Self-Exclusion load. */
  away: AwayView | null;
  /** The clock in unix seconds, for the end dates the confirm step shows. */
  now: number;
  /** The action that is running ("entry", "extend", "break" or "self-exclusion"), if any. */
  busy: string | null;
  error: string | null;
  onSetEntry: (gemas: number) => void;
  onSetExtend: (months: number) => void;
  onStartBreak: (days: number) => void;
  onStartSelfExclusion: (months: number) => void;
  onRetry: () => void;
}

const CHANGE_NOTE = {
  same: "Pick the most Gemas you want to enter into Matches in any 7 days.",
  raise: "A higher limit, or no limit, takes effect in 24 hours.",
  lower: "A lower limit takes effect now.",
  cancel: "This keeps your current limit and cancels the raise.",
} as const;

/** The Limits screen: the Entry Limit and the Extend Limit together, what is in force and what is waiting. */
export function LimitsView({ entry, extend, away, now, busy, error, onSetEntry, onSetExtend, onStartBreak, onStartSelfExclusion, onRetry }: LimitsViewProps) {
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
      <section className="stack" aria-labelledby="lim-break-h">
        <h3 id="lim-break-h" className="label">Break</h3>
        <p className="note">Step away for 1 to 42 days. No Matches, Requests, Offers or being backed. It cannot be ended early.</p>
        {away === null ? (
          <p className="meta" role="status">Loading…</p>
        ) : (
          <AwayControl
            kind="break"
            inForce={away.breakUntil}
            options={breakOptions(away, now)}
            label={breakLabel}
            end={(n) => breakEnd(now, n)}
            busy={busy === "break"}
            onStart={onStartBreak}
          />
        )}
      </section>
      <section className="stack" aria-labelledby="lim-se-h">
        <h3 id="lim-se-h" className="label">Self-Exclusion</h3>
        <p className="note">Stop for 6 months or more. A Break&apos;s limits plus no new Advances or Extends. It cannot be ended early. Redeem, Unlock and paying back keep working.</p>
        {away === null ? (
          <p className="meta" role="status">Loading…</p>
        ) : (
          <AwayControl
            kind="self-exclusion"
            inForce={away.selfExclusionUntil}
            options={selfExclusionOptions(away, now)}
            label={selfExclusionLabel}
            end={(n) => selfExclusionEnd(now, n)}
            busy={busy === "self-exclusion"}
            onStart={onStartSelfExclusion}
          />
        )}
      </section>
      {away && awayNotice(away) && <p className="status" role="status">{awayNotice(away)}</p>}
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

/** A Break or Self-Exclusion picker with a confirm step: the end date is shown, and the step says it cannot be undone. */
function AwayControl({
  kind,
  inForce,
  options,
  label,
  end,
  busy,
  onStart,
}: {
  kind: "break" | "self-exclusion";
  /** When the one in force ends (unix seconds); null when none runs. */
  inForce: number | null;
  options: number[];
  label: (n: number) => string;
  end: (n: number) => number;
  busy: boolean;
  onStart: (n: number) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const id = `${kind}-pick`;
  const pick = picked !== null && options.includes(picked) ? picked : (options[0] ?? null);
  const name = kind === "break" ? "Break" : "Self-Exclusion";
  return (
    <div className="ext-limit">
      {inForce !== null && (
        <p className="note"><b>{kind === "break" ? "On a Break" : "Self-Excluded"} until {fmtEnd(inForce)}.</b> It cannot be ended early{options.length ? ", only made longer." : "."}</p>
      )}
      {options.length === 0 ? null : confirming && pick !== null ? (
        <div className="stack" role="group" aria-label={`Confirm ${name}`}>
          <p className="note">{confirmText(kind, end(pick))}</p>
          <div className="ext-limit-row">
            <Button size="sm" disabled={busy} onClick={() => { onStart(pick); setConfirming(false); setPicked(null); }}>{busy ? "Saving…" : `Start ${name} until ${fmtEnd(end(pick))}`}</Button>
            <Button size="sm" variant="neutral" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor={id}>{inForce !== null ? "Make it longer" : `Start a ${name}`}</label>
          <div className="ext-limit-row">
            <span className="cut cut-chip ctl">
              <select id={id} className="select" value={pick ?? ""} onChange={(e) => setPicked(Number(e.target.value))}>
                {options.map((n) => (
                  <option key={n} value={n}>{label(n)}</option>
                ))}
              </select>
            </span>
            <Button size="sm" disabled={busy || pick === null} onClick={() => setConfirming(true)}>Continue</Button>
          </div>
          {pick !== null && <p className="adv-fee">Ends {fmtEnd(end(pick))}.</p>}
        </div>
      )}
    </div>
  );
}

const fmtEnd = (secs: number) => fmtWhen(secs * 1000);
