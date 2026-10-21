"use client";

import { Meter } from "@/components/ui";
import type { EntryPreview } from "@/lib/chain/entry";
import type { StagedEntry } from "@/lib/chain/ticket";
import { describeEntry } from "@/lib/chain/use-entry";
import { fmtGemas } from "@/lib/format";

const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const MONTH = 30 * 86_400;
/** Lines listed before "and N more". */
const SHOWN = 4;

/**
 * What the entry will use, exactly as the program draws it (own Gemas first, then the fastest: the ones whose
 * Lock repays soonest), and, for an entry put together in steps, how far along it is.
 * `nowSec`: the clock the "repays soon" cut is measured from.
 */
export function EntryPlan({ preview, staged = null, nowSec }: { preview: EntryPreview | null; staged?: StagedEntry | null; nowSec: number }) {
  if (!preview && !staged) return null;
  const words = preview ? describeEntry(preview, nowSec + MONTH) : null;
  return (
    <div className="enter-plan" aria-label="What your entry uses">
      {words && <p className="enter-plan-head">{words.headline}</p>}
      {words?.detail && <p className="meta">{words.detail}</p>}
      {staged && (
        <div className="enter-plan-staged" role="status">
          <Meter value={staged.progress} label="Entry prepared" />
          <span className="meta">
            Preparing your entry: <b className="tnum">{fmtGemas(Number(staged.staged))}</b> of <b className="tnum">{fmtGemas(Number(staged.target))}</b> Gemas ready.
            {staged.complete ? " Opening your Match…" : staged.stepsLeft > 0 ? ` About ${staged.stepsLeft} more ${staged.stepsLeft === 1 ? "step" : "steps"}.` : ""}
          </span>
          {!staged.complete && <span className="meta">Keep this page open. If you leave, your Gemas stay in your Account and the entry can be finished or cancelled later.</span>}
        </div>
      )}
      {preview && preview.steps.length > 0 && !staged && (
        <ul className="enter-plan-lines">
          {preview.steps.slice(0, SHOWN).map((s, i) => (
            <li key={`${s.source.toBase58()}:${s.dueAt}:${i}`}>
              <span className="tnum">{fmtGemas(Number(s.take))}</span> {s.isOwn ? "of your own" : "won"} Gemas, ready by <b>{DATE.format(new Date(s.dueAt * 1000))}</b>
            </li>
          ))}
          {preview.steps.length > SHOWN && <li className="meta">and {preview.steps.length - SHOWN} more</li>}
        </ul>
      )}
    </div>
  );
}
