"use client";

/**
 * PROTOTYPE ONLY (branch proto/pending-by-source-11-10-2026). Four takes on PendingBySource, switched by
 * `?variant=now|A|B|C|D` on every page that renders it (the component and the Wallet hero's Pending by Source).
 * Throwaway: the winner gets rewritten into money.tsx (and the Wallet) on main.
 */
import type { CSSProperties, ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { fmtGemas } from "@/lib/format";
import type { Chain } from "@/lib/mock/types";
import { GemaMark } from "./gema";
import { ChainGlyph } from "./inputs";
import "./pending-source.prototype.css";

export const PBS_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Share bar" },
  { key: "B", name: "Source tiles" },
  { key: "C", name: "Ledger" },
  { key: "D", name: "Next to land" },
] as const;

export interface PbsItem {
  key: string;
  chain: Chain;
  owner: string;
  pending: number;
  accruedShare: number;
  /** Short Position id, shown when known (the Wallet has it). */
  id?: string;
}

const ASSET = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const CHAIN_NAME: Record<Chain, string> = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" };
const pct = (s: number) => Math.round(Math.min(1, Math.max(0, s)) * 100);
const tint = (c: Chain) => ({ "--chain": `var(--pbs-${c.toLowerCase()})` }) as CSSProperties;

/** `titled={false}` drops each take's own "Pending by Source" title (the Wallet already has it on its toggle). */
export function PendingBySourcePrototype({ items, titled = true, children }: { items: PbsItem[]; titled?: boolean; children: ReactNode }) {
  const v = usePrototypeVariant(PBS_VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && children}
      <div className={titled ? undefined : "pbs-untitled"} style={{ display: v === "now" ? "none" : "contents" }}>
        {v === "A" && <ShareBar items={items} />}
        {v === "B" && <Tiles items={items} />}
        {v === "C" && <Ledger items={items} />}
        {v === "D" && <NextToLand items={items} />}
      </div>
      <PrototypeSwitcher variants={PBS_VARIANTS} />
    </>
  );
}

function Empty() {
  return (
    <div className="pbs-empty">
      <span className="pbs-empty-ring" aria-hidden="true"><GemaMark size={22} /></span>
      <span>
        <b>Nothing pending</b>
        All your Gemas are redeemable now.
      </span>
    </div>
  );
}

function Who({ it }: { it: PbsItem }) {
  return (
    <span className="pbs-who">
      <span>{it.owner}</span>
      <small>
        {it.chain} Source{it.id ? ` · ${it.id}` : ""}
      </small>
    </span>
  );
}

/* —— A: Share bar. Composition first: the whole Pending as one bar to scale, one slice per Source in its chain's
   colour, each slice's landed part lit; the legend rows under it own the figures. —— */
function ShareBar({ items }: { items: PbsItem[] }) {
  const total = items.reduce((s, it) => s + it.pending, 0);
  return (
    <div className="pbs-a">
      <div className="pbs-head">
        <span className="label">Pending by Source</span>
        <span className="pbs-head-fig tnum">{fmtGemas(total)}</span>
      </div>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="pbs-a-bar" role="img" aria-label={`Pending split across ${items.length} Sources`}>
            {items.map((it) => (
              <i key={it.key} style={{ ...tint(it.chain), flexGrow: it.pending }}>
                <em style={{ width: `${pct(it.accruedShare)}%` }} />
              </i>
            ))}
          </div>
          <ul className="pbs-a-list">
            {items.map((it) => (
              <li key={it.key} style={tint(it.chain)}>
                <span className="pbs-a-swatch" aria-hidden="true" />
                <ChainGlyph asset={ASSET[it.chain]} size={18} />
                <Who it={it} />
                <span className="pbs-a-share tnum">{Math.round((it.pending / total) * 100)}%</span>
                <b className="tnum">{fmtGemas(it.pending)}</b>
                <span className="pbs-a-acc tnum">{pct(it.accruedShare)}% landed</span>
              </li>
            ))}
          </ul>
          <p className="pbs-note">Lit part of each slice = yield landed so far. A Source turns redeemable as its yield lands.</p>
        </>
      )}
    </div>
  );
}

/* —— B: Source tiles. One cut tile per Source: the chain mark inside an octagon ring that lights one facet per
   eighth of yield landed, the figure big, the owner small. —— */
function FacetRing({ share, chain }: { share: number; chain: Chain }) {
  const lit = Math.round(Math.min(1, Math.max(0, share)) * 8);
  const r = 26;
  const pts = Array.from({ length: 8 }, (_, i) => {
    const a = ((i * 45 - 112.5) * Math.PI) / 180;
    return [30 + r * Math.cos(a), 30 + r * Math.sin(a)] as const;
  });
  return (
    <span className="pbs-ring" style={tint(chain)} aria-hidden="true">
      <svg className="pbs-ring-svg" viewBox="0 0 60 60" width="60" height="60">
        {pts.map((p, i) => {
          const q = pts[(i + 1) % 8];
          return <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className={i < lit ? "on" : ""} />;
        })}
      </svg>
      <ChainGlyph asset={ASSET[chain]} size={24} />
    </span>
  );
}

function Tiles({ items }: { items: PbsItem[] }) {
  return (
    <div className="pbs-b">
      <span className="label">Pending by Source</span>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <ul className="pbs-b-grid">
          {items.map((it) => (
            <li key={it.key} className="cut cut-card" style={tint(it.chain)}>
              <FacetRing share={it.accruedShare} chain={it.chain} />
              <b className="tnum">{fmtGemas(it.pending)}</b>
              <Who it={it} />
              <span className="pbs-b-acc tnum">
                <i style={{ width: `${pct(it.accruedShare)}%` }} />
                <span>{pct(it.accruedShare)}% of yield landed</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* —— C: Ledger. A plain statement: columns, pip meters, a total row. Dense, tabular, reads like a bank. —— */
function Pips({ share }: { share: number }) {
  const lit = Math.round(Math.min(1, Math.max(0, share)) * 10);
  return (
    <span className="pbs-pips" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < lit ? "on" : ""} />)}
    </span>
  );
}

function Ledger({ items }: { items: PbsItem[] }) {
  const total = items.reduce((s, it) => s + it.pending, 0);
  return (
    <div className="pbs-c">
      <span className="label">Pending by Source</span>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Yield landed</th>
              <th scope="col">Pending</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.key} style={tint(it.chain)}>
                <th scope="row">
                  <span className="pbs-c-src">
                    <span className="pbs-c-glyph"><ChainGlyph asset={ASSET[it.chain]} size={16} /></span>
                    <Who it={it} />
                  </span>
                </th>
                <td>
                  <span className="pbs-c-acc">
                    <Pips share={it.accruedShare} />
                    <span className="tnum">{pct(it.accruedShare)}%</span>
                  </span>
                </td>
                <td className="tnum">{fmtGemas(it.pending)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{items.length} Source{items.length === 1 ? "" : "s"}</th>
              <td />
              <td className="tnum">{fmtGemas(total)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

/* —— D: Next to land. Ordered by how close each Source is to redeemable: the closest one is the headline (big
   gauge, "71% there"), the rest queue up behind it as one-line chips. —— */
function NextToLand({ items }: { items: PbsItem[] }) {
  const sorted = [...items].sort((a, b) => b.accruedShare - a.accruedShare || b.pending - a.pending);
  const [first, ...rest] = sorted;
  return (
    <div className="pbs-d">
      <span className="label">Pending by Source</span>
      {!first ? (
        <Empty />
      ) : (
        <>
          <div className="pbs-d-lead" style={tint(first.chain)}>
            <span className="pbs-d-kicker">Next to land</span>
            <div className="pbs-d-row">
              <span className="pbs-d-mark"><ChainGlyph asset={ASSET[first.chain]} size={30} /></span>
              <div className="pbs-d-fig">
                <b className="tnum">{fmtGemas(first.pending)}</b>
                <span>Gemas from {first.owner} on {CHAIN_NAME[first.chain]}</span>
              </div>
              <span className="pbs-d-pct tnum">
                {pct(first.accruedShare)}<small>%</small>
              </span>
            </div>
            <div className="pbs-d-gauge" role="progressbar" aria-label={`${first.owner}: yield landed`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(first.accruedShare)}>
              <i style={{ width: `${pct(first.accruedShare)}%` }} />
              {Array.from({ length: 9 }, (_, i) => <s key={i} style={{ left: `${(i + 1) * 10}%` }} />)}
            </div>
            <span className="pbs-d-foot">of its yield has landed{first.id ? ` · Position ${first.id}` : ""}</span>
          </div>
          {rest.length > 0 && (
            <ol className="pbs-d-queue">
              {rest.map((it, i) => (
                <li key={it.key} style={tint(it.chain)}>
                  <span className="pbs-d-n tnum">{i + 2}</span>
                  <ChainGlyph asset={ASSET[it.chain]} size={16} />
                  <span className="pbs-d-who">{it.owner}</span>
                  <span className="pbs-d-mini" aria-hidden="true"><i style={{ width: `${pct(it.accruedShare)}%` }} /></span>
                  <span className="pbs-d-p tnum">{pct(it.accruedShare)}%</span>
                  <b className="tnum">{fmtGemas(it.pending)}</b>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
