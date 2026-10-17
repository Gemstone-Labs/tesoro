"use client";

/** A · To do: the Wallet as a short list of things you can do now. Positions and Sources sit behind it. */
import { useState } from "react";
import { Button } from "@/components/ui";
import { ChainTag, Gemas, StateTag } from "./bits";
import { CHAINS, INSTANT, byChain, fmtAgo, fmtAmt, fmtDate, fmtG, fmtIn, fmtUsd, gemasToAsset, pendingOf, posName, timeline, totals, type Fixture } from "./fixture";

export const nameA = "To do";

export function VariantA({ f }: { f: Fixture }) {
  const t = totals(f);
  const chains = byChain(f);
  const ready = chains.filter((c) => c.redeemable > 0);
  const readyWins = f.sources.filter((s) => s.redeemable > 0).length;
  const paid = f.positions.filter((p) => p.state === "paid");
  const own = f.positions.filter((p) => p.ownGemas > 0);
  const soon = timeline(f).filter((b) => b.sources > 0 || b.unlocks.length).slice(0, 4);
  const [all, setAll] = useState(false);

  return (
    <div className="pm pm-a">
      <header className="pm-a-head">
        <h1 className="page-title">Wallet</h1>
        <Gemas n={t.total} big />
        <p className="meta">
          {fmtG(t.redeemable)} ready to cash out · {fmtG(t.pending)} on the way
        </p>
      </header>

      <section className="pm-a-todo" aria-labelledby="a-now">
        <h2 id="a-now" className="pm-h">Ready now</h2>
        {t.redeemable > 0 && (
          <article className="cut pm-card money">
            <div>
              <h3>Cash out {fmtG(t.redeemable)} Gemas</h3>
              <p className="pm-pays">
                You get {ready.map((c) => fmtAmt(gemasToAsset(c.redeemable, c.chain), c.chain)).join(" + ")}
              </p>
              <p className="meta">The part of {readyWins} wins whose yield has landed. One tap redeems it all.</p>
            </div>
            <Button variant="money">Redeem all</Button>
          </article>
        )}
        {paid.map((p) => (
          <article className="cut pm-card" key={p.id}>
            <div>
              <h3>
                <ChainTag chain={p.chain} bare /> {posName(p)} is paid off
              </h3>
              <p className="meta">Take your {fmtAmt(p.principal, p.chain)} back, or take another Advance on it and keep playing.</p>
            </div>
            <div className="pm-btns">
              <Button variant="money">Unlock</Button>
              <Button>Another Advance</Button>
            </div>
          </article>
        ))}
        {own.map((p) => (
          <article className="cut pm-card" key={p.id}>
            <div>
              <h3>Pay down {posName(p)} sooner</h3>
              <p className="meta">
                You hold {fmtG(p.ownGemas)} Gemas from it. Returning them cuts its Debt by {fmtAmt(gemasToAsset(p.ownGemas, p.chain), p.chain)}.
              </p>
            </div>
            <Button>Return Gemas</Button>
          </article>
        ))}
        {t.pending > 0 && (
          <article className="cut pm-card quiet">
            <div>
              <h3>Can&apos;t wait?</h3>
              <p className="meta">
                Instant Redeem your {fmtG(t.pending)} pending Gemas now for {Math.round(INSTANT * 100)}% of their value: about {fmtUsd(t.pending * INSTANT)}.
              </p>
            </div>
            <Button>Instant Redeem</Button>
          </article>
        )}
      </section>

      <section aria-labelledby="a-soon">
        <h2 id="a-soon" className="pm-h">Coming up</h2>
        <ol className="pm-a-soon">
          {soon.map((b) => (
            <li key={b.key}>
              <span className="pm-a-when">{b.label}</span>
              <span>
                {b.sources > 0 && (
                  <>
                    <b>+{fmtG(CHAINS.reduce((s, c) => s + b.gemas[c], 0))}</b> Gemas become redeemable ({b.sources} wins)
                  </>
                )}
                {b.unlocks.map((p) => (
                  <em key={p.id}>
                    {posName(p)} paid off, {fmtAmt(p.principal, p.chain)} back {fmtDate(p.unlockAt)}
                  </em>
                ))}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="a-pos">
        <h2 id="a-pos" className="pm-h">Your Positions · {f.positions.length}</h2>
        <ul className="pm-a-rows">
          {f.positions.map((p) => (
            <li key={p.id}>
              <ChainTag chain={p.chain} bare />
              <b>{posName(p)}</b>
              <span className="tnum">{fmtAmt(p.principal, p.chain)}</span>
              <StateTag p={p} />
              <span className="meta">{p.state === "paid" ? "Ready to unlock" : `Back ${fmtDate(p.unlockAt)}`}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="pm-link" onClick={() => setAll((o) => !o)}>
          {all ? "Hide" : "See"} where your won Gemas come from · {f.sources.length} Sources
        </button>
        {all && (
          <ul className="pm-a-rows src">
            {f.sources.map((s) => (
              <li key={s.id}>
                <ChainTag chain={s.chain} bare />
                <b>{s.owner}</b>
                <span className="meta">
                  {s.from} · {fmtAgo(s.wonAt, f.now)}
                </span>
                <span className="tnum">{fmtG(s.gemas)}</span>
                <span className="meta">{pendingOf(s) === 0 ? "Redeemable" : `All redeemable ${fmtIn(s.readyAt, f.now)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
