import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { delayedLine, matchStanding } from "@/lib/chain/match-status";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./history.css";

/** Matches that should have settled by now and have not, above the finished ones. Each links to its Match. */
export function DelayedMatches({ matches, now }: { matches: ChainMatch[]; now: number }) {
  const rows = matches.flatMap((m) => {
    const s = matchStanding(m, Math.floor(now / 1000));
    return s.kind === "delayed" ? [{ m, s }] : [];
  });
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.m.deadline - b.m.deadline);
  return (
    <section className="mh-delayed" aria-label="Delayed Matches">
      <h2 className="h-section">Delayed</h2>
      <p className="meta">These Matches should have settled by now. Your Gemas are safe: each one refunds at the latest by the time shown.</p>
      <div className="mh-delayed-list" role="list">
        {rows.map(({ m, s }) => (
          <Link key={m.id.toString()} href={`/play/match/${m.id.toString()}`} role="listitem" className="cut cut-card mh-delayed-row">
            <b>{GAME_NAMES[m.game]}</b>
            <span className="mh-delayed-entry">
              <GemaMark size={12} /> {fmtGemas(m.entry)} in
            </span>
            <span className="mh-delayed-status">{delayedLine(s, now)}</span>
            <ArrowRight aria-hidden="true" />
          </Link>
        ))}
      </div>
    </section>
  );
}
