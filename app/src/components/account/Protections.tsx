"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/money/Tip";
import { useAuth } from "@/lib/auth/context";
import { getChain } from "@/lib/chain/client";
import { entryLimitView, fetchEntryLimit, type EntryLimitData, type EntryLimitView } from "@/lib/chain/entry-limit";
import { awayView, fetchAway, type AwayData, type AwayView } from "@/lib/chain/protections";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { fmtGemas, fmtWhen } from "@/lib/format";
import { setLimitsOpen, useLimitsOpen } from "@/lib/identity/limits-sheet";

/** The Entry Limit row's value: "Off", or what is left of the limit. */
export function entryRowText(v: EntryLimitView | null): string {
  if (v === null) return "Not read";
  return v.limit === null ? "Off" : `${fmtGemas(v.remaining ?? 0)} left of ${fmtGemas(v.limit)}`;
}

/** The Break row's value: "Off", the Break's end, or the Self-Exclusion's. */
export function breakRowText(v: AwayView | null): string {
  if (v === null) return "Not read";
  if (v.kind === null || v.until === null) return "Off";
  return `${v.kind === "break" ? "Until" : "Self-Excluded until"} ${fmtWhen(v.until * 1000)}`;
}

/** Your own Account only: the limits you set on yourself. Each row opens the Limits sheet, where they are changed. */
export function Protections() {
  const auth = useAuth();
  const owner = auth.signer?.publicKey;
  const key = owner?.toBase58();
  const sheetOpen = useLimitsOpen();
  const now = useNowSecs(30_000);
  const [entry, setEntry] = useState<EntryLimitData | "unknown" | undefined>(undefined);
  const [away, setAway] = useState<AwayData | "unknown" | undefined>(undefined);

  // Read again each time the Limits sheet closes: that is where they change.
  useEffect(() => {
    if (!owner || sheetOpen) return;
    let live = true;
    const base = getChain().base;
    void fetchEntryLimit(base, owner).catch((): "unknown" => "unknown").then((l) => live && setEntry(l));
    void fetchAway(base, owner).catch((): "unknown" => "unknown").then((l) => live && setAway(l));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sheetOpen]);

  const entryView = entry === undefined || entry === "unknown" ? null : entryLimitView(entry, now);
  const awayV = away === undefined || away === "unknown" ? null : awayView(away, now);
  const rows: [string, string | null][] = [
    ["Entry Limit", entry === undefined ? null : entryRowText(entryView)],
    ["Break", away === undefined ? null : breakRowText(awayV)],
  ];

  return (
    <section className="cut cut-card pa-prot" aria-labelledby="pa-prot-h">
      <h2 id="pa-prot-h" className="pa-lab">
        Protections
        <InfoTip label="About Protections" align="start">
          Limits you set on yourself: how many Gemas you can enter in 7 days, and time away from playing. Redeem and Unlock always work.
        </InfoTip>
      </h2>
      <ul>
        {rows.map(([label, value]) => (
          <li key={label}>
            <button type="button" className="pa-prot-row" onClick={() => setLimitsOpen(true)}>
              <span>{label}</span>
              {value === null ? <span className="skel-line" style={{ width: 56 }} aria-hidden="true" /> : <b className={value === "Off" ? "off" : undefined}>{value}</b>}
              <ChevronRight aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
