"use client";

/** C · Timeline: "when does this become money?" Pending Gemas and your Unlocks laid out over the next 12 months. */
import { useState } from "react";
import { Button } from "@/components/ui";
import { ChainTag, Gemas } from "./bits";
import { CHAINS, byChain, fmtAmt, fmtDate, fmtG, fmtIn, fmtUsd, gemasToAsset, pendingOf, posName, timeline, totals, type Fixture } from "./fixture";

export const nameC = "Timeline";

export function VariantC({ f }: { f: Fixture }) {
  const t = totals(f);
  const buckets = timeline(f);
  const chains = byChain(f);
  const paid = f.positions.filter((p) => p.state === "paid");
  const sum = (b: (typeof buckets)[number]) => CHAINS.reduce((s, c) => s + b.gemas[c], 0);
  const max = Math.max(t.redeemable, ...buckets.map(sum), 1);
  const [open, setOpen] = useState<string | null>(null);
  const runningAt: number[] = [];
  for (const b of buckets) runningAt.push((runningAt[runningAt.length - 1] ?? t.redeemable) + sum(b));

  return (
    <div className="pm pm-c">
      <header className="pm-c-head">
        <h1 className="page-title">Wallet</h1>
        <Gemas n={t.total} big />
        <ul className="pm-legend">
          {CHAINS.map((c) => (
            <li key={c}>
              <i className={`sw c-${c}`} /> {c}
            </li>
          ))}
        </ul>
      </header>

      <section aria-labelledby="c-h">
        <h2 id="c-h" className="pm-h">When your Gemas turn into coins</h2>
        <ol className="pm-c-line">
          <li className="now">
            <span className="pm-c-dot" />
            <div className="pm-c-label">
              <b>Now</b>
              <small>redeemable</small>
            </div>
            <Bar gemas={Object.fromEntries(chains.map((c) => [c.chain, c.redeemable]))} max={max} />
            <div className="pm-c-amt">
              <b className="tnum">{fmtG(t.redeemable)}</b>
              <small>{fmtUsd(t.redeemable)}</small>
            </div>
            <div className="pm-c-act">
              <Button variant="money" size="sm" disabled={!t.redeemable}>Redeem</Button>
            </div>
            {paid.length > 0 && (
              <div className="pm-c-events">
                {paid.map((p) => (
                  <span className="pm-c-ev ok" key={p.id}>
                    <ChainTag chain={p.chain} bare /> {posName(p)} paid off: {fmtAmt(p.principal, p.chain)} ready to unlock <button type="button" className="pm-link">Unlock</button>
                  </span>
                ))}
              </div>
            )}
          </li>
          {buckets.map((b, i) => {
            const g = sum(b);
            const running = runningAt[i];
            const isOpen = open === b.key;
            const list = isOpen
              ? f.sources.filter((s) => pendingOf(s) > 0 && (buckets.find((x) => s.readyAt <= x.end) ?? buckets[buckets.length - 1]).key === b.key)
              : [];
            if (!g && !b.unlocks.length) return null;
            return (
              <li key={b.key}>
                <span className="pm-c-dot" />
                <div className="pm-c-label">
                  <b>{b.label}</b>
                  <small>by {fmtDate(b.end)}</small>
                </div>
                <Bar gemas={b.gemas} max={max} />
                <div className="pm-c-amt">
                  <b className="tnum">+{fmtG(g)}</b>
                  <small>{fmtG(running)} in all by then</small>
                </div>
                <div className="pm-c-act">
                  {b.sources > 0 && (
                    <button type="button" className="pm-link" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.key)}>
                      {b.sources} wins
                    </button>
                  )}
                </div>
                {b.unlocks.length > 0 && (
                  <div className="pm-c-events">
                    {b.unlocks.map((p) => (
                      <span className="pm-c-ev" key={p.id}>
                        <ChainTag chain={p.chain} bare /> {posName(p)} paid off {fmtDate(p.unlockAt)}: your {fmtAmt(p.principal, p.chain)} back
                      </span>
                    ))}
                  </div>
                )}
                {isOpen && (
                  <ul className="pm-c-src">
                    {list.map((s) => (
                      <li key={s.id}>
                        <ChainTag chain={s.chain} bare />
                        <span>
                          {s.owner} <small className="meta">{s.from}</small>
                        </span>
                        <span className="tnum">{fmtG(pendingOf(s))}</span>
                        <span className="meta">{fmtIn(s.readyAt, f.now)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
        <p className="note">
          Dates are estimates: each win becomes redeemable as the loser&apos;s Position earns its yield. Can&apos;t wait? Instant Redeem pays 75% now.{" "}
          <button type="button" className="pm-link">Instant Redeem {fmtUsd(t.pending * 0.75)}</button>
        </p>
      </section>

      <section aria-labelledby="c-pos">
        <h2 id="c-pos" className="pm-h">Your Positions · {f.positions.length}</h2>
        <div className="pm-c-pos">
          {f.positions.map((p) => (
            <span key={p.id} className={`cut pm-c-chip${p.state === "paid" ? " ok" : ""}`}>
              <ChainTag chain={p.chain} bare />
              <b>{fmtAmt(p.principal, p.chain)}</b>
              <small>{p.state === "paid" ? "ready to unlock" : `back ${fmtDate(p.unlockAt)}`}</small>
              {p.ownGemas > 0 && <small>· {fmtAmt(gemasToAsset(p.ownGemas, p.chain), p.chain)} Debt you can Return</small>}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function Bar({ gemas, max }: { gemas: Record<string, number>; max: number }) {
  return (
    <div className="pm-c-bar" aria-hidden="true">
      {CHAINS.map((c) => (gemas[c] ? <i key={c} className={`c-${c}`} style={{ width: `${(gemas[c] / max) * 100}%` }} /> : null))}
    </div>
  );
}
