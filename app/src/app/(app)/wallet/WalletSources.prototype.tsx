"use client";

// THROWAWAY: Which hierarchy explains 240 Sources? Three variants on /wallet?prototype=sources&variant=A.
// Sample data deliberately replaces only this page's rendering. No transactions or persistence.
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, ChainChip, GemaMark, Sheet } from "@/components/ui";
import { PrototypeSwitcher } from "@/components/ui/PrototypeSwitcher";
import type { Chain } from "@/lib/mock";
import "./wallet-sources.prototype.css";

type Source = { id: string; asset: Chain; origin: string; total: number; ready: number; reserved: number; rate: number; waiting: string };
const assets: Chain[] = ["SOL", "ETH", "HYPE"];
const networks = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" };
const variants = { A: "What can I do?", B: "By redemption asset", C: "Source explorer" };
const n = (v: number) => v.toLocaleString("en-US");
const sources: Source[] = Array.from({ length: 240 }, (_, i) => ({
  id: `SRC-${String(i + 1).padStart(4, "0")}`, asset: assets[i % 3],
  origin: i % 5 === 0 ? "Leaderboard" : i % 2 === 0 ? "Hold’em" : "Block Puzzle",
  total: 100 + (i % 8) * 25, ready: i % 4 === 0 ? 75 : 0,
  reserved: i % 17 === 0 ? 25 : 0,
  rate: [0.00006, 0.000003, 0.00025][i % 3] * (1 + (i % 4) / 10),
  waiting: i % 11 === 0 ? "Estimate unavailable" : "Yield still accruing",
}));
const sum = (rows: Source[], k: "total" | "ready" | "reserved") => rows.reduce((s, r) => s + r[k], 0);
const total = sum(sources, "total"), ready = sum(sources, "ready"), reserved = sum(sources, "reserved");
const payout = (rows: Source[], instant = false) => rows.reduce((s, r) => s + (instant ? (r.total - r.ready - r.reserved) * .75 : r.ready) * r.rate, 0).toFixed(6);

export function WalletSourcesPrototype() {
  const params = useSearchParams();
  const variant = params.get("variant") ?? "A";
  const [review, setReview] = useState<{ rows: Source[]; instant: boolean } | null>(null);
  const [detail, setDetail] = useState<Source | null>(null);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [completed, setCompleted] = useState<Chain[]>([]);
  const openReview = (rows: Source[], instant = false) => { setReview({ rows: rows.filter(r => instant ? r.total - r.ready - r.reserved > 0 : r.ready > 0), instant }); setCompleted([]); };
  const sourceList = (rows: Source[]) => <div className="wsp-list">{rows.map(r => <button className="wsp-source" key={r.id} onClick={() => setDetail(r)}><span><b>{r.id}</b><small>{r.origin} · {networks[r.asset]}</small></span><span><b>{n(r.total)} Gemas</b><small>{r.ready ? `${n(r.ready)} redeemable` : r.waiting}</small></span><span aria-hidden="true">↗</span></button>)}</div>;
  const owned = <section className="wsp-owned"><div className="wsp-heading"><h2>Your Positions</h2><span>3 Positions · your Principal and Debt</span></div><p>These are the Positions you opened. Winning Gemas does not give you someone else’s Principal or Debt.</p>{assets.map((asset, i) => <details key={asset}><summary><ChainChip chain={asset} /><b>{["12 SOL", "0.8 ETH", "40 HYPE"][i]}</b><span>{i === 0 ? "Ready to unlock" : "Yield repaying Debt"}</span></summary><p>{i === 0 ? "Debt is zero. You can unlock your Principal or take another Advance." : `Only this Position’s yield or returning your own-Sourced Gemas reduces its Debt. Won Gemas do not shorten its lock.`}</p><p className="meta">Sample Position · actions omitted from this Source-organisation study.</p></details>)}</section>;
  return <div className="wsp">
    <div className="wsp-proto-note">Design study · 240 sample Sources + 3 owned Positions · page figures are fictional · header uses a separate sample · no transactions</div>
    <header className="page-head"><div><h1 className="page-title">Wallet</h1><p className="page-sub">Your Gemas, with a clear next step.</p></div><span className="meta">All networks</span></header>
    {variant === "A" && <>
      <section className="wsp-overview"><div className="wsp-play"><span className="wsp-eyebrow">Available to play</span><div className="wsp-big"><GemaMark size={42} />{n(total - reserved)}</div><p>Gemas from all your Sources, ready for games.</p><p className="meta">Includes pending Gemas. {n(reserved)} more reserved for Backing.</p></div><Card><span className="wsp-eyebrow">Redeemable now</span><b className="wsp-amount wsp-money">{n(ready)} <small>Gemas</small></b><p>Yield has accrued across {sources.filter(r => r.ready).length} Sources.</p><Button variant="money" onClick={() => openReview(sources)}>Review redemption</Button></Card><Card><span className="wsp-eyebrow">Pending redemption</span><b className="wsp-amount">{n(total - ready)} <small>Gemas</small></b><p>Still usable in games when not reserved. Redeem as each Source earns yield.</p><Button onClick={() => openReview(sources, true)}>Compare Instant Redeem</Button></Card></section>
      <div className="wsp-explain">You do not need to manage 240 Sources to play. Gemas keep their Source so redemption pays the right asset.</div>
      <div className="wsp-action-heading"><h2>Redeem into</h2><Button size="sm" onClick={() => { const url = new URL(window.location.href); url.searchParams.set("variant", "C"); window.history.replaceState(null, "", url); }}>View all 240 Sources</Button></div>
      <div className="wsp-asset-strip">{assets.map(asset => { const rows = sources.filter(r => r.asset === asset); return <details key={asset}><summary><ChainChip chain={asset} /><b>{payout(rows)} {asset}</b><small>{n(sum(rows, "ready"))} Gemas ready · {rows.length} Sources</small></summary>{sourceList(rows.filter(r => r.ready))}</details>; })}</div>
      {owned}
    </>}
    {variant === "B" && <>
      <div className="wsp-b-header"><p><b>{n(total - reserved)} Gemas</b> available to play across every network.</p><p>Choose the asset you want to redeem. Each group contains many independent Sources.</p></div>
      <section className="wsp-assets">{assets.map(asset => { const rows = sources.filter(r => r.asset === asset); return <Card key={asset}><ChainChip chain={asset} /><h2>{networks[asset]}</h2><b className="wsp-amount">{n(sum(rows, "total"))}<small> Gemas</small></b><dl><dt>Redeemable now</dt><dd className="wsp-money">{n(sum(rows, "ready"))}</dd><dt>Pending</dt><dd>{n(sum(rows, "total") - sum(rows, "ready"))}</dd><dt>Reserved for Backing</dt><dd>{n(sum(rows, "reserved"))}</dd><dt>You receive now</dt><dd>{payout(rows)} {asset}</dd></dl><Button variant="money" block onClick={() => openReview(rows)}>Review {asset} redemption</Button><details><summary>{rows.length} Sources · inspect</summary>{sourceList(rows)}</details></Card>; })}</section>
      {owned}
    </>}
    {variant === "C" && <>
      <div className="wsp-explorer-head"><div><b>{n(total)} Gemas</b><p>{n(ready)} redeemable · {n(total - ready)} pending · {n(reserved)} reserved (included)</p></div><Button variant="money" onClick={() => openReview(sources)}>Review all redeemable</Button></div>
      <section className="wsp-explorer"><aside><h2>Gema Sources</h2>{["All", "Redeemable", "Pending", "No estimate", ...assets].map(f => <Button key={f} aria-pressed={filter === f} onClick={() => { setFilter(f); setPage(0); }}>{f}</Button>)}<p className="meta">Use this view when you want to trace a specific reward.</p></aside><div><label className="wsp-search">Find a Source<input placeholder="Search ID, game, or Leaderboard" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>{(() => { const rows = sources.filter(r => (filter === "All" || filter === r.asset || filter === "Redeemable" && r.ready > 0 || filter === "Pending" && r.total > r.ready || filter === "No estimate" && r.waiting === "Estimate unavailable") && `${r.id} ${r.origin}`.toLowerCase().includes(search.toLowerCase())); return <><p className="meta">{rows.length} Sources · {n(sum(rows, "total"))} Gemas · showing {rows.length ? page * 12 + 1 : 0}–{Math.min((page + 1) * 12, rows.length)}</p>{sourceList(rows.slice(page * 12, (page + 1) * 12))}{rows.length === 0 && <p>No Sources match. Try another search or filter.</p>}<div className="wsp-pagination"><Button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button disabled={(page + 1) * 12 >= rows.length} onClick={() => setPage(page + 1)}>Next</Button></div></>; })()}</div></section>
      {owned}
    </>}
    <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail?.id ?? "Source"}>{detail && <div className="stack"><ChainChip chain={detail.asset} /><p>Gemas won through {detail.origin}. This Source belongs to another Player’s Advance.</p><dl className="wsp-detail"><dt>Your Gemas</dt><dd>{n(detail.total)}</dd><dt>Redeemable now</dt><dd>{n(detail.ready)}</dd><dt>Pending</dt><dd>{n(detail.total - detail.ready)}</dd><dt>Reserved (included above)</dt><dd>{n(detail.reserved)}</dd><dt>Sample amount per Gema</dt><dd>{detail.rate.toFixed(8)} {detail.asset}</dd></dl><p>{detail.waiting}. Pending Gemas become redeemable as this Source Position earns yield; timing is not guaranteed.</p><Button variant="money" disabled={!detail.ready} onClick={() => { openReview([detail]); setDetail(null); }}>Review redemption</Button></div>}</Sheet>
    <Sheet open={!!review} onClose={() => setReview(null)} title={review?.instant ? "Compare Instant Redeem" : "Review redemption"}>{review && <div className="stack"><p>{review.instant ? "Sample quote: receive 75% of the eligible pending asset amount now; the 25% Instant Redeem Fee is deducted. Waiting lets you redeem the full Source asset amount as yield accrues. Availability depends on the Treasury." : `${n(sum(review.rows, "ready"))} Gemas across ${review.rows.length} Sources are eligible in this sample.`}</p><p className="meta">Separate payouts by network. This does not swap your Gemas into one asset. Network costs and delivery estimates would be quoted before confirmation.</p>{assets.filter(a => review.rows.some(r => r.asset === a)).map(asset => { const rows = review.rows.filter(r => r.asset === asset); return <Card key={asset}><ChainChip chain={asset} /><h3>{payout(rows, review.instant)} {asset}</h3><p>{rows.length} Sources → your {networks[asset]} address</p><Button disabled={completed.includes(asset)} onClick={() => setCompleted([...completed, asset])}>{completed.includes(asset) ? "Simulated payout complete" : `Simulate ${asset} payout`}</Button></Card>; })}<p role="status">{completed.length ? `${completed.length} network payout(s) simulated. Other networks remain separate.` : "Preview only. No wallet signature or transfer."}</p></div>}</Sheet>
    <details className="wsp-debug"><summary>Prototype assumptions & current state</summary><p>Question: which overview remains understandable after hundreds of wins? 240 won Sources; 3 owned Positions; redemption is partial; 15 Sources contain reserved Gemas. The shell retains the app’s separate fixture. Sample rates differ per Source; no dollar sum or promised redemption dates. Instant Redeem uses a configurable sample fee of 25%. Grouping is presentation, never merging claims.</p><pre>{JSON.stringify({ variant, filter, search, page, total, ready, pending: total-ready, reserved, available: total-reserved, review, detail, completed, sources }, null, 2)}</pre></details>
    <PrototypeSwitcher variants={variants} />
  </div>;
}
