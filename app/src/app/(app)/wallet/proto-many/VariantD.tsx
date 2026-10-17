"use client";

/** D · Ledger: one dense list of everything, with filters, grouping and pick-to-redeem. For players who want to see it all. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
import { ChainTag, Gemas, StateTag } from "./bits";
import { CHAINS, fmtAgo, fmtAmt, fmtDate, fmtG, fmtIn, fmtUsd, pendingOf, posName, totals, type Fixture, type Source } from "./fixture";

export const nameD = "Ledger";

type Status = "all" | "ready" | "pending";
type Group = "none" | "chain" | "when" | "origin";
const PAGE = 40;

const whenGroup = (s: Source, now: number) => {
  if (!pendingOf(s)) return "Redeemable now";
  const d = (s.readyAt - now) / 86_400_000;
  return d <= 30 ? "Within a month" : d <= 182 ? "In 1–6 months" : "In 6–12 months";
};
const originGroup = (s: Source) => (s.origin === "match" ? "Match wins" : s.origin === "season" ? "Season payouts" : "Backings won");

export function VariantD({ f }: { f: Fixture }) {
  const t = totals(f);
  const [chain, setChain] = useState<Chain | "all">("all");
  const [status, setStatus] = useState<Status>("all");
  const [group, setGroup] = useState<Group>("when");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(
    () =>
      f.sources.filter(
        (s) =>
          (chain === "all" || s.chain === chain) &&
          (status === "all" || (status === "ready" ? s.redeemable > 0 : pendingOf(s) > 0)) &&
          (!q || `${s.owner} ${s.from}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [f.sources, chain, status, q],
  );
  const groups = useMemo(() => {
    const key = (s: Source) => (group === "chain" ? s.chain : group === "when" ? whenGroup(s, f.now) : group === "origin" ? originGroup(s) : "");
    const m = new Map<string, Source[]>();
    for (const s of rows.slice(0, shown)) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
    const order = ["Redeemable now", "Within a month", "In 1–6 months", "In 6–12 months", ...CHAINS, "Match wins", "Season payouts", "Backings won"];
    return [...m.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [rows, group, shown, f.now]);

  const picked = f.sources.filter((s) => pick.has(s.id));
  const pickedReady = picked.reduce((a, s) => a + s.redeemable, 0);
  const toggle = (ids: string[], on: boolean) =>
    setPick((p) => {
      const n = new Set(p);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  return (
    <div className="pm pm-d">
      <header className="pm-d-head">
        <h1 className="page-title">Wallet</h1>
        <dl>
          <div>
            <dt>Total</dt>
            <dd><Gemas n={t.total} /></dd>
          </div>
          <div>
            <dt>Redeemable</dt>
            <dd><Gemas n={t.redeemable} /></dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd><Gemas n={t.pending} /></dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="d-pos">
        <h2 id="d-pos" className="pm-h">Your Positions · {f.positions.length}</h2>
        <div className="pm-d-table" role="table">
          <div className="pm-d-tr th pos" role="row">
            <span>Position</span>
            <span>Locked</span>
            <span>Debt</span>
            <span>State</span>
            <span>Back</span>
            <span />
          </div>
          {f.positions.map((p) => (
            <div className="pm-d-tr pos" role="row" key={p.id}>
              <span>
                <ChainTag chain={p.chain} bare /> {posName(p)}
              </span>
              <span className="tnum">{fmtAmt(p.principal, p.chain)}</span>
              <span className="tnum">{p.debt ? fmtAmt(p.debt, p.chain) : "—"}</span>
              <span><StateTag p={p} /></span>
              <span className="meta">{p.state === "paid" ? "now" : fmtDate(p.unlockAt)}</span>
              <span>
                {p.state === "paid" ? <Button size="sm" variant="money">Unlock</Button> : p.ownGemas ? <Button size="sm">Return {fmtG(p.ownGemas)}</Button> : null}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="d-src">
        <h2 id="d-src" className="pm-h">Won Gemas · {f.sources.length} Sources</h2>
        <div className="pm-d-tools">
          <input className="pm-d-q" placeholder="Search a player or game" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pm-seg" role="group" aria-label="Chain">
            {(["all", ...CHAINS] as const).map((c) => (
              <button key={c} type="button" aria-pressed={chain === c} onClick={() => setChain(c)}>
                {c === "all" ? "All" : c}
              </button>
            ))}
          </div>
          <div className="pm-seg" role="group" aria-label="Status">
            {(["all", "ready", "pending"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s === "all" ? "Any" : s === "ready" ? "Redeemable" : "Pending"}
              </button>
            ))}
          </div>
          <label className="pm-d-group">
            Group by
            <select value={group} onChange={(e) => setGroup(e.target.value as Group)}>
              <option value="when">When redeemable</option>
              <option value="chain">Chain</option>
              <option value="origin">Where won</option>
              <option value="none">Nothing</option>
            </select>
          </label>
        </div>

        <div className="pm-d-table" role="table">
          <div className="pm-d-tr th" role="row">
            <span />
            <span>Won from</span>
            <span>Gemas</span>
            <span>Redeemable</span>
            <span>All redeemable</span>
            <span>Won</span>
          </div>
          {groups.map(([g, list]) => (
            <div key={g || "all"} role="rowgroup">
              {g && (
                <div className="pm-d-gh" role="row">
                  <label>
                    <input type="checkbox" checked={list.every((s) => pick.has(s.id))} onChange={(e) => toggle(list.map((s) => s.id), e.target.checked)} />
                    {g}
                  </label>
                  <span className="meta">
                    {list.length} · {fmtG(list.reduce((a, s) => a + s.gemas, 0))} Gemas
                  </span>
                </div>
              )}
              {list.map((s) => (
                <label className="pm-d-tr" role="row" key={s.id}>
                  <span>
                    <input type="checkbox" checked={pick.has(s.id)} onChange={(e) => toggle([s.id], e.target.checked)} />
                  </span>
                  <span>
                    <ChainTag chain={s.chain} bare /> {s.owner}
                    <small className="meta"> {s.from}</small>
                  </span>
                  <span className="tnum">{fmtG(s.gemas)}</span>
                  <span className="tnum">{s.redeemable ? fmtG(s.redeemable) : "—"}</span>
                  <span className="meta">{pendingOf(s) ? `${fmtIn(s.readyAt, f.now)}` : "now"}</span>
                  <span className="meta">{fmtAgo(s.wonAt, f.now)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        {rows.length > shown && (
          <button type="button" className="pm-link" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
          </button>
        )}
      </section>

      {pick.size > 0 && (
        <div className="cut pm-d-bulk" role="status">
          <span>
            <b>{pick.size}</b> picked · {fmtG(pickedReady)} redeemable ({fmtUsd(pickedReady)})
            {picked.some((s) => s.chain !== picked[0].chain) ? " · pays more than one coin" : ` · paid in ${picked[0].chain}`}
          </span>
          <Button variant="money" size="sm" disabled={!pickedReady}>Redeem picked</Button>
          <Button size="sm">Instant Redeem</Button>
          <button type="button" className="pm-link" onClick={() => setPick(new Set())}>Clear</button>
        </div>
      )}
      <p className="meta">Pending dates are estimates ({fmtDate(f.now)}).</p>
    </div>
  );
}
