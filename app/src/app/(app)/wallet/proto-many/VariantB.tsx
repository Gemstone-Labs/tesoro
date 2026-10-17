"use client";

/** B · By chain: one pocket per coin (SOL, ETH, HYPE). Everything about a coin lives in its pocket. */
import { useState } from "react";
import { Button, Meter } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
import { ChainTag, Gemas } from "./bits";
import { USD, byChain, fmtAmt, fmtDate, fmtG, fmtIn, fmtUsd, gemasToAsset, pendingOf, posName, totals, type ChainSum, type Fixture } from "./fixture";

export const nameB = "By chain";

export function VariantB({ f }: { f: Fixture }) {
  const t = totals(f);
  const chains = byChain(f).filter((c) => c.sources || c.positions.length);
  const [tab, setTab] = useState<Chain>(chains[0]?.chain ?? "SOL");

  return (
    <div className="pm pm-b">
      <header className="pm-b-head">
        <div>
          <h1 className="page-title">Wallet</h1>
          <Gemas n={t.total} big />
        </div>
        <Button variant="money" size="lg">Open a Position</Button>
      </header>
      <div className="pm-b-tabs" role="tablist">
        {chains.map((c) => (
          <button key={c.chain} role="tab" type="button" aria-selected={tab === c.chain} onClick={() => setTab(c.chain)}>
            <ChainTag chain={c.chain} />
            <span className="tnum">{fmtG(c.gemas + c.ownGemas)}</span>
          </button>
        ))}
      </div>
      <div className="pm-b-cols">
        {chains.map((c) => (
          <Pocket key={c.chain} c={c} f={f} hiddenOnPhone={tab !== c.chain} />
        ))}
      </div>
    </div>
  );
}

function Pocket({ c, f, hiddenOnPhone }: { c: ChainSum; f: Fixture; hiddenOnPhone: boolean }) {
  const [open, setOpen] = useState(false);
  const src = f.sources.filter((s) => s.chain === c.chain).sort((a, b) => pendingOf(b) - pendingOf(a));
  const shown = open ? src : src.slice(0, 5);
  const value = gemasToAsset(c.gemas + c.ownGemas, c.chain);
  const share = c.gemas ? c.redeemable / c.gemas : 0;

  return (
    <section className={`cut pm-b-pocket c-${c.chain}${hiddenOnPhone ? " phone-hide" : ""}`} aria-label={`${c.chain} pocket`}>
      <header>
        <ChainTag chain={c.chain} />
        <span className="pm-b-val">
          <b>{fmtAmt(value, c.chain)}</b>
          <small>
            {fmtG(c.gemas + c.ownGemas)} Gemas · 1 {c.chain} = ${USD[c.chain].toLocaleString("en-US")}
          </small>
        </span>
      </header>

      <div className="pm-b-redeem">
        <div>
          <small>Redeemable now</small>
          <b className="tnum">{fmtAmt(gemasToAsset(c.redeemable, c.chain), c.chain)}</b>
          <span className="meta">
            {fmtG(c.redeemable)} Gemas · {fmtUsd(c.redeemable)}
          </span>
        </div>
        <Button variant="money" size="sm" disabled={!c.redeemable}>Redeem {c.chain}</Button>
      </div>
      <div className="pm-b-bar">
        <Meter value={share} label={`${c.chain}: redeemable share`} />
        <span className="meta">
          {fmtG(c.pending)} pending{c.lastReady ? `, all redeemable by ${fmtDate(c.lastReady)}` : ""}
        </span>
      </div>

      {c.positions.length > 0 && (
        <div className="pm-b-sub">
          <h3>Your {c.chain} Positions</h3>
          {c.positions.map((p) => (
            <div className="pm-b-pos" key={p.id}>
              <b>{posName(p)}</b>
              <span className="tnum">{fmtAmt(p.principal, c.chain)}</span>
              {p.state === "paid" ? (
                <Button size="sm" variant="money">Unlock</Button>
              ) : (
                <span className="meta">back {fmtIn(p.unlockAt, f.now)}</span>
              )}
              {p.state === "repaying" && <Meter value={1 - p.debt / p.debtStart} label={`${posName(p)} repaid`} />}
              {p.ownGemas > 0 && (
                <button type="button" className="pm-link">
                  Return your {fmtG(p.ownGemas)} Gemas to it
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {src.length > 0 && (
        <div className="pm-b-sub">
          <h3>Won from {src.length} Positions</h3>
          <ul className="pm-b-src">
            {shown.map((s) => (
              <li key={s.id}>
                <span>{s.owner}</span>
                <span className="tnum">{fmtG(s.gemas)}</span>
                <Meter value={s.redeemable / s.gemas} label={`${s.owner}: redeemable`} />
              </li>
            ))}
          </ul>
          {src.length > 5 && (
            <button type="button" className="pm-link" onClick={() => setOpen((o) => !o)}>
              {open ? "Show fewer" : `Show all ${src.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
