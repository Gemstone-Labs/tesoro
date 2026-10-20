"use client";

import { type ReactNode, useState } from "react";
import { Button, ChainGlyph, Meter, Sheet } from "@/components/ui";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { fmtAsset, fmtGemas, fmtGemasUsd, fmtInMinutes } from "@/lib/format";
import type { Chain } from "@/lib/mock";

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const TOP = 5;
const PAGE = 20;

/** Won Gemas from one Player's Positions on a chain. */
export interface PocketSource {
  key: string;
  /** The Player's Account key, when read from chain: shows their name and avatar. */
  account: string | null;
  /** Shown when there is no Account key (offline data). */
  owner: string;
  gemas: number;
  redeemable: number;
}

/** Everything the Account has on one chain: its Gemas, its own Positions, and the Players its won Gemas came from. */
export interface Pocket {
  chain: Chain;
  gemas: number;
  /** What those Gemas redeem for, in the chain's asset; null when it cannot be priced (offline data). */
  gemasAsset: number | null;
  redeemable: number;
  redeemableAsset: number | null;
  /** Won Gemas here are all pending: Redeem fetches the latest yield first. */
  fetchYield?: boolean;
  positions: ReactNode[];
  /** Unlocked Positions: kept out of the way until asked for. */
  closed: ReactNode[];
  sources: PocketSource[];
  /** When the soonest of your own repaying Positions covers its Debt (ms), so its Gemas turn redeemable; null when unknown. */
  nextRedeemAt?: number | null;
}

/** "Next Gemas redeemable in ~24 min", counting down; the plain fallback when no time can be projected. */
export function NextRedeem({ at, className }: { at: number | null | undefined; className?: string }) {
  const secs = useNowSecs(15_000);
  return (
    <span className={className ?? "meta"}>
      {at ? `Next Gemas redeemable ${fmtInMinutes(at, Math.max(secs * 1000, 0))}` : "Redeemable as the Locks they came from earn yield"}
    </span>
  );
}

export function ChainPockets({ pockets, onRedeem }: { pockets: Pocket[]; onRedeem: (chain: Chain) => void }) {
  const [tab, setTab] = useState<Chain>(pockets[0]?.chain ?? "SOL");
  const [all, setAll] = useState<Pocket | null>(null);
  const shown = pockets.some((p) => p.chain === tab) ? tab : pockets[0]?.chain;
  return (
    <>
      {pockets.length > 1 && (
        <div className="wl-pocket-tabs" role="tablist" aria-label="Chains">
          {pockets.map((p) => (
            <button key={p.chain} type="button" role="tab" aria-selected={shown === p.chain} onClick={() => setTab(p.chain)}>
              <ChainGlyph asset={GLYPH[p.chain]} size={16} />
              {p.chain}
              <span className="tnum">{fmtGemas(p.gemas)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="wl-pockets">
        {pockets.map((p) => (
          <PocketCard key={p.chain} p={p} hidden={shown !== p.chain} onRedeem={() => onRedeem(p.chain)} onAll={() => setAll(p)} />
        ))}
      </div>
      <SourcesSheet pocket={all} onClose={() => setAll(null)} />
    </>
  );
}

function PocketCard({ p, hidden, onRedeem, onAll }: { p: Pocket; hidden: boolean; onRedeem: () => void; onAll: () => void }) {
  const pending = Math.max(0, p.gemas - p.redeemable);
  const [closedOpen, setClosedOpen] = useState(false);
  const top = [...p.sources].sort((a, b) => b.gemas - a.gemas).slice(0, TOP);
  return (
    <section className={`cut cut-card wl-pocket c-${p.chain}${hidden ? " phone-hidden" : ""}`} aria-label={`${p.chain}`}>
      <header className="wl-pocket-head">
        <span className="wl-pocket-chain">
          <ChainGlyph asset={GLYPH[p.chain]} size={20} />
          {p.chain}
        </span>
        <span className="wl-pocket-label">Your Gemas on {p.chain}</span>
        <b>{fmtGemas(p.gemas)} Gemas</b>
        <small>{p.gemasAsset !== null ? `≈ ${fmtAsset(p.gemasAsset, p.chain)} · ${fmtGemasUsd(p.gemas)}` : fmtGemasUsd(p.gemas)}</small>
      </header>

      {p.gemas > 0 && (
        <div className="wl-pocket-money">
          <div className="wl-pocket-redeem">
            <div>
              <small>Redeemable now</small>
              <b>{p.redeemableAsset !== null ? fmtAsset(p.redeemableAsset, p.chain) : fmtGemas(p.redeemable)}</b>
              <span className="meta">{fmtGemas(p.redeemable)} Gemas</span>
            </div>
            {p.redeemable > 0 || p.fetchYield ? (
              <Button variant="money" size="sm" onClick={onRedeem}>
                {p.redeemable > 0 ? `Redeem ${p.chain}` : `Get ${p.chain} yield`}
              </Button>
            ) : (
              <span className="meta wl-pocket-why">Nothing to redeem yet</span>
            )}
          </div>
          <Meter value={p.gemas ? p.redeemable / p.gemas : 0} label={`${p.chain}: share of your Gemas redeemable now`} />
          {pending > 0 ? (
            <>
              <span className="meta">{fmtGemas(pending)} Pending</span>
              <NextRedeem at={p.nextRedeemAt} />
            </>
          ) : (
            <span className="meta">Nothing pending</span>
          )}
        </div>
      )}

      {(p.positions.length > 0 || p.closed.length > 0) && (
        <div className="wl-pocket-part wl-pocket-locks">
          <h3>Your {p.chain} Locks</h3>
          {p.positions.length > 0 && <div className="wl-pocket-pos">{p.positions}</div>}
          {p.closed.length > 0 && (
            <button type="button" className="wl-link" aria-expanded={closedOpen} onClick={() => setClosedOpen((o) => !o)}>
              {closedOpen ? "Hide" : "Show"} {p.closed.length} unlocked
            </button>
          )}
          {closedOpen && <div className="wl-pocket-pos">{p.closed}</div>}
        </div>
      )}

      {p.sources.length > 0 && (
        <div className="wl-pocket-part wl-pocket-won">
          <h3>
            Won from {p.sources.length} {p.sources.length === 1 ? "Player" : "Players"}
          </h3>
          <ul className="wl-src">
            {top.map((s) => (
              <SourceRow key={s.key} s={s} />
            ))}
          </ul>
          {p.sources.length > TOP && (
            <button type="button" className="wl-link" onClick={onAll}>
              Show all {p.sources.length}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SourceRow({ s, wide }: { s: PocketSource; wide?: boolean }) {
  const share = s.gemas ? s.redeemable / s.gemas : 0;
  return (
    <li className={wide ? "wide" : undefined}>
      {wide && (s.account ? <PlayerAvatar account={s.account} size={28} className="wl-src-face" /> : <span />)}
      <span className="wl-src-who">{s.account ? <PlayerName account={s.account} /> : s.owner}</span>
      <span className="tnum">{fmtGemas(s.gemas)}</span>
      <Meter value={share} label={`Gemas won from ${s.owner}: share redeemable now`} />
      {wide && <span className="meta tnum">{share >= 1 ? "All redeemable" : `${fmtGemas(s.redeemable)} redeemable`}</span>}
    </li>
  );
}

type Sort = "gemas" | "redeemable";

/** Every Player a chain's won Gemas came from, a page at a time. */
function SourcesSheet({ pocket, onClose }: { pocket: Pocket | null; onClose: () => void }) {
  const [sort, setSort] = useState<Sort>("gemas");
  const [page, setPage] = useState(0);
  const list = pocket ? [...pocket.sources].sort((a, b) => (sort === "gemas" ? b.gemas - a.gemas : b.redeemable - a.redeemable)) : [];
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const at = Math.min(page, pages - 1);
  const close = () => {
    setPage(0);
    onClose();
  };
  const pick = (s: Sort) => {
    setSort(s);
    setPage(0);
  };
  return (
    <Sheet open={!!pocket} onClose={close} title={pocket ? `${pocket.chain} Gemas you won` : "Gemas you won"} className="wl-src-sheet">
      {pocket && (
        <div className="wl-src-all">
          <p className="meta">
            From {list.length} Players. Won Gemas stay tied to the Lock they came from and become redeemable as it earns yield; Redeem {pocket.chain} pays out all
            of them at once.
          </p>
          <div className="wl-src-sort" role="group" aria-label="Sort">
            <button type="button" aria-pressed={sort === "gemas"} onClick={() => pick("gemas")}>
              Most Gemas
            </button>
            <button type="button" aria-pressed={sort === "redeemable"} onClick={() => pick("redeemable")}>
              Most redeemable
            </button>
          </div>
          <ul className="wl-src">
            {list.slice(at * PAGE, at * PAGE + PAGE).map((s) => (
              <SourceRow key={s.key} s={s} wide />
            ))}
          </ul>
          {pages > 1 && (
            <nav className="wl-pager" aria-label="Pages">
              <Button size="sm" disabled={at === 0} onClick={() => setPage(at - 1)}>
                Previous
              </Button>
              <span className="tnum">
                Page {at + 1} of {pages}
              </span>
              <Button size="sm" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                Next
              </Button>
            </nav>
          )}
        </div>
      )}
    </Sheet>
  );
}
