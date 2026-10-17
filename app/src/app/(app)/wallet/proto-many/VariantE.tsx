"use client";

/**
 * E · Two numbers: a bank-app Wallet. Gemas are one balance (Sources are never listed: Redeem picks them for you),
 * and your locked coins are one short list. The question it asks: does a Player ever need to see a Source?
 */
import { Button, GemaMark } from "@/components/ui";
import { ChainTag } from "./bits";
import { CHAINS, INSTANT, byChain, fmtAmt, fmtDate, fmtG, fmtIn, fmtUsd, gemasToAsset, posName, timeline, totals, type Fixture } from "./fixture";

export const nameE = "Two numbers";

export function VariantE({ f }: { f: Fixture }) {
  const t = totals(f);
  const chains = byChain(f);
  const buckets = timeline(f);
  const paid = f.positions.filter((p) => p.state === "paid");
  const repaying = f.positions.filter((p) => p.state === "repaying").sort((a, b) => a.unlockAt - b.unlockAt);
  const locked = CHAINS.map((c) => ({ c, n: f.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.principal, 0) })).filter((x) => x.n);
  // cumulative share of all Gemas that is redeemable by the end of each window
  const steps = [{ label: "Now", v: t.redeemable }];
  for (const b of buckets) steps.push({ label: b.label.replace("In ", ""), v: steps[steps.length - 1].v + CHAINS.reduce((s, c) => s + b.gemas[c], 0) });
  const max = Math.max(t.won, 1);

  return (
    <div className="pm pm-e">
      <h1 className="page-title">Wallet</h1>
      <div className="pm-e-two">
        <section className="cut pm-e-card gemas" aria-labelledby="e-g">
          <h2 id="e-g">Your Gemas</h2>
          <p className="pm-e-big">
            <GemaMark size={44} glint />
            <b>{fmtG(t.total)}</b>
            <small>{fmtUsd(t.total)}</small>
          </p>
          <div className="pm-e-split">
            <div>
              <small>Cash out now</small>
              <b>{fmtG(t.redeemable)}</b>
            </div>
            <div>
              <small>Still on the way</small>
              <b>{fmtG(t.pending)}</b>
            </div>
          </div>
          <div className="pm-e-steps" aria-label="How much you can cash out over time">
            {steps.map((s) => (
              <div key={s.label}>
                <i style={{ height: `${Math.max(4, (s.v / max) * 100)}%` }} />
                <small>{s.label}</small>
              </div>
            ))}
          </div>
          <div className="pm-btns">
            <Button variant="money" disabled={!t.redeemable}>Cash out {fmtUsd(t.redeemable)}</Button>
            <Button>Cash out all now · {fmtUsd(t.redeemable + t.pending * INSTANT)}</Button>
          </div>
          <p className="meta">
            Paid as {chains.filter((c) => c.redeemable).map((c) => fmtAmt(gemasToAsset(c.redeemable, c.chain), c.chain)).join(" + ")}. &ldquo;All now&rdquo; pays the part
            still on the way at {Math.round(INSTANT * 100)}%.
          </p>
        </section>

        <section className="cut pm-e-card" aria-labelledby="e-l">
          <h2 id="e-l">Your locked coins</h2>
          <p className="pm-e-big">
            <b>{locked.map((x) => fmtAmt(x.n, x.c)).join(" · ")}</b>
          </p>
          <p className="meta">
            {f.positions.length} Positions. They come back once their yield has paid off their Advance.
          </p>
          {paid.length > 0 && (
            <div className="pm-e-group">
              <h3>Ready to unlock</h3>
              {paid.map((p) => (
                <div className="pm-e-row" key={p.id}>
                  <ChainTag chain={p.chain} bare />
                  <span>{fmtAmt(p.principal, p.chain)}</span>
                  <Button size="sm" variant="money">Unlock</Button>
                </div>
              ))}
            </div>
          )}
          {repaying.length > 0 && (
            <div className="pm-e-group">
              <h3>Paying off</h3>
              {repaying.map((p) => (
                <div className="pm-e-row" key={p.id}>
                  <ChainTag chain={p.chain} bare />
                  <span>{fmtAmt(p.principal, p.chain)}</span>
                  <span className="meta" title={posName(p)}>
                    back {fmtDate(p.unlockAt)} · {fmtIn(p.unlockAt, f.now)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <Button block>Open a Position</Button>
        </section>
      </div>
    </div>
  );
}
