"use client";

/**
 * PROTOTYPE ONLY. Four takes on the SOL "Open a Position" form (`NativeOpenForm`), switched by
 * `?variant=now|A|B|C|D` (floating bar). Same data and the same open action in every variant; only
 * the rendering differs. The winner gets rewritten properly into NativePositions / OpenPanel on main.
 *
 *   A  Swap        — "You lock" panel over a "You get" panel, Horizon as a month rail
 *   B  Sentence    — "Lock [5] SOL for [3 months]" in display type, then an itemised receipt
 *   C  Timeline    — the Debt drawn falling from Gemas to zero at the Unlock time; drag the end
 *   D  Pick by result — every Horizon as a tile with the Gemas it pays; you pick the result
 */
import { useId, useState, type ReactNode } from "react";
import { Button, ChainGlyph, GemaAmount, GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas, fmtWhen } from "@/lib/format";
import { getTestSimSol } from "@/lib/chain/native-flow";
import type { NativeMarket } from "@/lib/chain/native";
import "./native-open.prototype.css";

export const NOF_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Swap" },
  { key: "B", name: "Sentence + receipt" },
  { key: "C", name: "Timeline" },
  { key: "D", name: "Pick by result" },
] as const;
export type NofVariant = (typeof NOF_VARIANTS)[number]["key"];

export type OpenModel = {
  market: NativeMarket | null;
  loading: boolean;
  balance: number;
  text: string;
  setText: (v: string) => void;
  months: number;
  setMonths: (m: number) => void;
  gemas: number;
  usd: string;
  principalSol: string;
  yieldSol: string;
  priceLine: string;
  apyPct: number;
  estimateMs: number | null;
  now: number;
  tooMuch: boolean;
  alerts: ReactNode;
  buttonLabel: string;
  disabled: boolean;
  submit: () => void;
  /** Gemas a Horizon of `m` months would issue for the current Amount. */
  gemasFor: (m: number) => number;
  /** Unlock time (ms) for a Horizon of `m` months: the yield clock runs 1 month = 10 min. */
  unlockFor: (m: number) => number;
};

const MONTH_MS = 10 * 60_000;
const fmt3 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const mo = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const inMin = (ms: number, now: number) => {
  const m = Math.round((ms - now) / 60_000);
  return m < 1 ? "any moment now" : `in ~${m} min`;
};

/** The faucet as one quiet line: balance, Get test simSOL. */
function FaucetLine({ m, cls }: { m: OpenModel; cls?: string }) {
  const { auth, refresh } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const get = async () => {
    if (!auth.signer) return;
    setBusy("Getting simSOL");
    try {
      await getTestSimSol(auth.signer, auth.getAccessToken, setBusy);
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`nof-faucet ${cls ?? ""}`}>
      <span className="meta">
        {m.loading ? "Loading your Account…" : <>You have <b className="tnum">{m.market ? fmt3(m.balance) : "—"}</b> simSOL</>}
      </span>
      <button type="button" className="nof-link" disabled={!auth.signer || busy !== null} onClick={get}>
        {busy ? `${busy}…` : "Get test simSOL"}
      </button>
    </div>
  );
}

function Presets({ m }: { m: OpenModel }) {
  if (!m.market || m.balance <= 0) return null;
  const set = (f: number) => m.setText(String(Math.floor(m.balance * f * 1000) / 1000));
  return (
    <div className="nof-presets">
      {[["25%", 0.25], ["50%", 0.5], ["Max", 1]].map(([l, f]) => (
        <button key={l} type="button" className="cut cut-chip nof-preset" onClick={() => set(f as number)}>{l}</button>
      ))}
    </div>
  );
}

function Details({ m, open = false }: { m: OpenModel; open?: boolean }) {
  return (
    <details className="wl-details" open={open}>
      <summary>Quote details</summary>
      <dl className="kv">
        <dt>Worth at issuance</dt><dd>{m.usd}</dd>
        <dt>Principal</dt><dd>{m.principalSol} SOL</dd>
        <dt>Projected yield</dt><dd>{m.yieldSol} SOL</dd>
        <dt>Price feed</dt><dd>{m.priceLine}</dd>
      </dl>
    </details>
  );
}

const Sim = () => <span className="sim">Simulated yield · 1 month = 10 min</span>;

function Submit({ m }: { m: OpenModel }) {
  return (
    <Button variant="money" size="lg" block disabled={m.disabled} onClick={m.submit}>
      {m.buttonLabel}
    </Button>
  );
}

// ---- A · Swap ------------------------------------------------------------------------------------

const RAIL = [1, 2, 3, 6, 9, 12];

function VariantA({ m }: { m: OpenModel }) {
  const id = useId();
  return (
    <div className="nof nof-a">
      <div className={`cut cut-card nof-a-pay${m.tooMuch ? " bad" : ""}`}>
        <div className="spread">
          <label className="label" htmlFor={id}>You lock</label>
          <FaucetLine m={m} cls="inline" />
        </div>
        <div className="nof-a-row">
          <input id={id} className="nof-a-input" inputMode="decimal" placeholder="0" value={m.text} disabled={!m.market} onChange={(e) => m.setText(e.target.value)} aria-invalid={m.tooMuch} aria-label="Amount" />
          <span className="cut cut-chip nof-asset"><ChainGlyph asset={0} size={18} /> SOL</span>
        </div>
        <div className="spread">
          <span className="meta">Principal, locked. Never played with.</span>
          <Presets m={m} />
        </div>
      </div>

      <div className="nof-a-join" aria-hidden="true"><span className="cut cut-chip">↓</span></div>

      <div className="cut cut-card nof-a-get">
        <span className="label">You get now</span>
        <div className="nof-a-figure">
          {m.gemas > 0 ? <GemaAmount value={m.gemas} size="xl" /> : <span className="nof-dim"><GemaMark size={28} /> 0</span>}
          <span className="meta">{m.gemas > 0 ? `≈ ${m.usd}` : "Gemas"}</span>
        </div>
        <div className="nof-a-horizon" role="radiogroup" aria-label="Horizon">
          <span className="meta">Repaid by yield over</span>
          <div className="nof-a-rail">
            {RAIL.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={m.months === n} className={m.months === n ? "on" : ""} onClick={() => m.setMonths(n)}>
                {n}<small>mo</small>
              </button>
            ))}
          </div>
        </div>
        <div className="spread nof-a-unlock">
          <span className="meta">Principal unlocks</span>
          <b>{m.estimateMs ? `${clock(m.estimateMs)} · ${inMin(m.estimateMs, m.now)}` : "—"}</b>
        </div>
      </div>

      {m.alerts}
      <Submit m={m} />
      <div className="spread nof-foot"><Sim /><Details m={m} /></div>
    </div>
  );
}

// ---- B · Sentence + receipt ----------------------------------------------------------------------

function VariantB({ m }: { m: OpenModel }) {
  return (
    <div className="nof nof-b">
      <FaucetLine m={m} />
      <p className="nof-b-sentence display">
        Lock{" "}
        <span className={`nof-b-slot${m.tooMuch ? " bad" : ""}`}>
          <input inputMode="decimal" placeholder="0" value={m.text} disabled={!m.market} onChange={(e) => m.setText(e.target.value)} aria-label="Amount in SOL" style={{ width: `${Math.max(1, m.text.length) * 0.62 + 0.15}em` }} />
        </span>{" "}
        SOL for{" "}
        <span className="nof-b-slot sel">
          <select value={m.months} onChange={(e) => m.setMonths(Number(e.target.value))} aria-label="Horizon">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{mo(n)}</option>)}
          </select>
        </span>
      </p>
      <Presets m={m} />

      <div className="nof-b-receipt">
        <div className="nof-b-line"><span>Principal locked</span><b className="tnum">{m.principalSol} SOL</b></div>
        <div className="nof-b-line sub"><span>back to you at Unlock</span></div>
        <div className="nof-b-line"><span>Its yield over {mo(m.months)}</span><b className="tnum">{m.yieldSol} SOL</b></div>
        <div className="nof-b-line sub"><span>{m.apyPct}% a year · {m.priceLine}</span></div>
        <div className="nof-b-rule" aria-hidden="true" />
        <div className="nof-b-line total">
          <span>Paid to you now</span>
          {m.gemas > 0 ? <GemaAmount value={m.gemas} size="lg" /> : <b className="nof-dim">— Gemas</b>}
        </div>
        <div className="nof-b-line sub"><span>worth {m.usd} at issuance</span></div>
        <div className="nof-b-line"><span>Unlocks</span><b>{m.estimateMs ? `${fmtWhen(m.estimateMs)} (${inMin(m.estimateMs, m.now)})` : "—"}</b></div>
        <div className="nof-b-tear" aria-hidden="true" />
        <Sim />
      </div>
      {m.alerts}
      <Submit m={m} />
    </div>
  );
}

// ---- C · Timeline --------------------------------------------------------------------------------

function VariantC({ m }: { m: OpenModel }) {
  const id = useId();
  const W = 400;
  const H = 150;
  const x = (mo: number) => 18 + (mo / 12) * (W - 36);
  const yTop = 22;
  const yBase = H - 28;
  const end = x(m.months);
  const pct = m.market && m.balance > 0 ? Math.min(1, Number(m.text || 0) / m.balance) : 0;
  return (
    <div className="nof nof-c">
      <div className="nof-c-amount">
        <label className="label" htmlFor={id}>Lock</label>
        <div className={`cut cut-card nof-c-field${m.tooMuch ? " bad" : ""}`}>
          <input id={id} inputMode="decimal" placeholder="0.0" value={m.text} disabled={!m.market} onChange={(e) => m.setText(e.target.value)} aria-invalid={m.tooMuch} aria-label="Amount" />
          <span>SOL</span>
        </div>
        <div className="nof-c-meter" aria-hidden="true"><i style={{ width: `${pct * 100}%` }} className={m.tooMuch ? "bad" : ""} /></div>
        <FaucetLine m={m} />
      </div>

      <div className="cut cut-card nof-c-chart">
        <div className="spread">
          <span className="label">Now</span>
          <span className="label">Horizon · {mo(m.months)}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Debt of ${fmtGemas(m.gemas)} Gemas repaid by yield over ${mo(m.months)}`}>
          <defs>
            <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#33e3b4" stopOpacity=".38" />
              <stop offset="1" stopColor="#33e3b4" stopOpacity="0" />
            </linearGradient>
          </defs>
          {Array.from({ length: 13 }, (_, i) => (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={yBase} y2={yBase + (i % 3 === 0 ? 7 : 4)} stroke="rgba(234,239,236,.28)" />
              {(i === 1 || i % 3 === 0) && i > 0 && <text x={x(i)} y={H - 6} textAnchor="middle" className="nof-c-tick">{i}</text>}
            </g>
          ))}
          <line x1={x(0)} x2={x(12)} y1={yBase} y2={yBase} stroke="rgba(234,239,236,.18)" />
          <path d={`M${x(0)} ${yTop} L${end} ${yBase} L${x(0)} ${yBase} Z`} fill={`url(#${id}-f)`} />
          <line x1={x(0)} y1={yTop} x2={end} y2={yBase} stroke="#5ef3cd" strokeWidth="2.5" />
          <circle cx={x(0)} cy={yTop} r="5" fill="#5ef3cd" />
          <g transform={`translate(${end} ${yBase})`}>
            <rect x="-7" y="-7" width="14" height="14" transform="rotate(45)" fill="#eaefec" />
          </g>
          <text x={x(0) + 12} y={yTop + 4} className="nof-c-lab">Debt {m.gemas > 0 ? fmtGemas(m.gemas) : "—"}</text>
          <text x={end > W - 90 ? end - 14 : end + 14} y={yBase - 6} textAnchor={end > W - 90 ? "end" : "start"} className="nof-c-lab">Unlocks {m.estimateMs ? clock(m.estimateMs) : ""}</text>
        </svg>
        <input
          className="nof-c-range"
          type="range"
          min={1}
          max={12}
          value={m.months}
          onChange={(e) => m.setMonths(Number(e.target.value))}
          aria-label="Horizon in months"
          style={{ ["--p" as string]: `${((m.months - 0) / 12) * 100}%` }}
        />
        <p className="meta">Yield repays the Debt. Drag to choose when it reaches zero.</p>
      </div>

      <div className="nof-c-ends">
        <div className="cut cut-card nof-c-end money">
          <span className="label">You get now</span>
          {m.gemas > 0 ? <GemaAmount value={m.gemas} size="lg" /> : <b className="nof-dim">— Gemas</b>}
          <span className="meta">≈ {m.usd}</span>
        </div>
        <div className="cut cut-card nof-c-end">
          <span className="label">Principal unlocks</span>
          <b className="nof-c-time">{m.estimateMs ? clock(m.estimateMs) : "—"}</b>
          <span className="meta">{m.estimateMs ? inMin(m.estimateMs, m.now) : "estimate"}</span>
        </div>
      </div>
      {m.alerts}
      <Submit m={m} />
      <div className="spread nof-foot"><Sim /><Details m={m} /></div>
    </div>
  );
}

// ---- D · Pick by result --------------------------------------------------------------------------

function VariantD({ m }: { m: OpenModel }) {
  const id = useId();
  const has = m.market && Number(m.text) > 0;
  return (
    <div className="nof nof-d">
      <section className="nof-d-step">
        <span className="nof-d-num" aria-hidden="true">1</span>
        <div className="nof-d-body">
          <label className="nof-d-title" htmlFor={id}>How much SOL to lock</label>
          <div className={`cut cut-card nof-d-field${m.tooMuch ? " bad" : ""}`}>
            <ChainGlyph asset={0} size={20} />
            <input id={id} inputMode="decimal" placeholder="0.0" value={m.text} disabled={!m.market} onChange={(e) => m.setText(e.target.value)} aria-invalid={m.tooMuch} />
            <Presets m={m} />
          </div>
          <FaucetLine m={m} />
        </div>
      </section>

      <section className="nof-d-step">
        <span className="nof-d-num" aria-hidden="true">2</span>
        <div className="nof-d-body">
          <span className="nof-d-title">Pick your Advance</span>
          <span className="meta">Longer Horizon, more Gemas now. Your Principal unlocks when yield has repaid them.</span>
          <div className="nof-d-grid" role="radiogroup" aria-label="Horizon">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => {
              const on = m.months === n;
              return (
                <button key={n} type="button" role="radio" aria-checked={on} className={`cut cut-card nof-d-tile${on ? " on" : ""}`} onClick={() => m.setMonths(n)}>
                  <span className="nof-d-mo">{n} mo</span>
                  <span className="nof-d-g">{has ? <><GemaMark size={12} /> {fmtGemas(m.gemasFor(n))}</> : "—"}</span>
                  <span className="nof-d-t">{has ? clock(m.unlockFor(n)) : ""}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <div className="cut cut-card nof-d-sum">
        <div>
          <span className="label">You get now</span>
          {m.gemas > 0 ? <GemaAmount value={m.gemas} size="lg" /> : <b className="nof-dim">— Gemas</b>}
        </div>
        <div className="nof-d-sum-r">
          <span className="label">Unlocks</span>
          <b>{m.estimateMs ? clock(m.estimateMs) : "—"}</b>
          <span className="meta">{m.estimateMs ? inMin(m.estimateMs, m.now) : ""}</span>
        </div>
      </div>
      {m.alerts}
      <Submit m={m} />
      <div className="spread nof-foot"><Sim /><Details m={m} /></div>
    </div>
  );
}

export function NativeOpenPrototype({ variant, m }: { variant: Exclude<NofVariant, "now">; m: OpenModel }) {
  if (variant === "A") return <VariantA m={m} />;
  if (variant === "B") return <VariantB m={m} />;
  if (variant === "C") return <VariantC m={m} />;
  return <VariantD m={m} />;
}

export { MONTH_MS };
