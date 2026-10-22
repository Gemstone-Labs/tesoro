"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { packArt } from "@/components/deposit/DepositPanel";
import { Button, CheckIcon, GemaMark } from "@/components/ui";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { depositProgress, fmtBackAt, fmtTimeLeft, likelyPack, type DepositRow } from "@/lib/deposit/vault";
import { fmtGemas, fmtUsd } from "@/lib/format";

const TAG: Record<DepositRow["state"], string> = { ready: "Ready", growing: "Coming back", late: "Running late" };

/** Ready deposits first, then the soonest back. */
const order = (a: DepositRow, b: DepositRow) =>
  Number(b.state === "ready") - Number(a.state === "ready") || (a.backAtMs ?? Infinity) - (b.backAtMs ?? Infinity);

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** One card per deposit: its pack art, what it is worth, the Gemas it gave, how far along it is and when it comes back. */
export function DepositCards({ deposits, busyId, canWithdraw, onWithdraw }: {
  deposits: DepositRow[];
  /** `withdraw:<id>` while that withdraw runs. */
  busyId: string | null;
  canWithdraw: boolean;
  onWithdraw: (d: DepositRow) => void;
}) {
  const now = useNow();
  return (
    <div className="vt-cards">
      {[...deposits].sort(order).map((d) => {
        const worth = d.worthUsd === null ? "—" : fmtUsd(Math.round(d.worthUsd));
        const done = depositProgress(d, now);
        return (
          <article key={d.id} className={`cut cut-card vt-card ${d.state}`} aria-label={d.label}>
            <span className="vt-card-tag">{TAG[d.state]}</span>
            <Image className="vt-card-art" src={packArt(likelyPack(d.worthUsd))} width={512} height={512} alt="" sizes="(max-width: 639px) 96px, 150px" />
            <h3>{d.label}</h3>
            <p className="vt-card-worth">{worth}<small>worth today</small></p>
            {d.gemasGiven !== null && (
              <p className="vt-card-gave"><GemaMark size={16} /> Gave you {fmtGemas(d.gemasGiven)} Gemas</p>
            )}
            <div className="vt-bar" role="progressbar" aria-label="On its way back" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}>
              <i style={{ width: `${done * 100}%` }} />
            </div>
            <p className="vt-card-when">
              {d.state === "ready" && <span className="ok"><CheckIcon aria-hidden="true" /> Ready to withdraw</span>}
              {d.state === "late" && <span className="warn">{d.backAtMs ? `Taking a little longer · about ${fmtBackAt(d.backAtMs)}` : "Taking a little longer. We'll show a new date soon."}</span>}
              {d.state === "growing" && (d.backAtMs
                ? <span>Back in <b>{fmtTimeLeft(d.backAtMs - now)}</b></span>
                : <span>Back after about {PACK_MONTHS} months</span>)}
            </p>
            {d.state === "ready" && (
              <Button variant="money" size="lg" block disabled={!canWithdraw || busyId !== null} onClick={() => onWithdraw(d)}>
                {busyId === `withdraw:${d.id}` ? "Withdrawing…" : `Withdraw ${worth}`}
              </Button>
            )}
          </article>
        );
      })}
    </div>
  );
}
