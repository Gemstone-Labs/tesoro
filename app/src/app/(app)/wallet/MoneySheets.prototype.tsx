"use client";

/**
 * PROTOTYPE ONLY (branch proto/money-sheets-11-10-2026). Four takes on the Redeem and Return sheets on the live
 * forms, switched by `?variant=now|A|B|C|D`; `?pstate=live|busy|done|error` previews the other states. The winner
 * gets rewritten into MoneySheets.tsx / NativePositions.tsx; this file never lands on main.
 *
 * A Payout slip: one big figure, a perforated slip of what you receive and when.
 * B Exchange:    "You give" Gemas → "You get" assets, Sources folded away.
 * C Pick Sources: each Source a card you tick (Redeem) or pick and drag inline (Return).
 * D Route:       Redeem as a route of payouts that light up; Return as an unlock ring.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Busy, ChainGlyph, CheckIcon, ClockIcon, GemaAmount, GemaMark, SimulatedYieldLabel, Slider } from "@/components/ui";
import { Receipts, type Receipt } from "@/components/match/Receipts";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import "./money-sheets.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Payout slip" },
  { key: "B", name: "Exchange" },
  { key: "C", name: "Pick Sources" },
  { key: "D", name: "Route / ring" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
const KEYS = VARIANTS.map((v) => v.key) as Key[];
export const useSheetVariant = () => usePrototypeVariant(KEYS);

export type Asset3 = "SOL" | "ETH" | "HYPE";
export type Phase = "idle" | "busy" | "done" | "error";
const GLYPH: Record<Asset3, 0 | 1 | 2> = { SOL: 0, ETH: 1, HYPE: 2 };
const CHAIN: Record<Asset3, string> = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" };
const DIGITS: Record<Asset3, number> = { SOL: 5, ETH: 6, HYPE: 4 };
const fmtPay = (n: number, a: Asset3) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: DIGITS[a] });

/* ——— preview state (prototype only) ——— */

const PSTATES = ["live", "busy", "done", "error"] as const;
type PState = (typeof PSTATES)[number];
const EVENT = "prototype-variant";
const sub = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("popstate", cb);
  };
};
const readP = () => new URLSearchParams(window.location.search).get("pstate");
function usePState(): PState {
  const v = useSyncExternalStore(sub, readP, () => null);
  return (PSTATES as readonly string[]).includes(v ?? "") ? (v as PState) : "live";
}
function setPState(p: PState) {
  const url = new URL(window.location.href);
  url.searchParams.set("pstate", p);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

function ProtoBar() {
  const pop = useRef<HTMLDivElement>(null);
  const p = usePState();
  // After the sheet's showModal (parent effects run after this one), so the bar sits above the modal.
  useEffect(() => {
    const t = setTimeout(() => {
      if (pop.current && !pop.current.matches(":popover-open")) pop.current.showPopover();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  if (process.env.NODE_ENV === "production") return null;
  return (
    <>
      <PrototypeSwitcher variants={VARIANTS} inDialog />
      <div ref={pop} popover="manual" className="ms-proto-state">
        state
        {PSTATES.map((s) => (
          <button key={s} type="button" aria-pressed={s === p} onClick={() => setPState(s)}>{s}</button>
        ))}
      </div>
    </>
  );
}

/* ——— shared bits ——— */

function Glyph({ asset, size = 18 }: { asset: Asset3; size?: number }) {
  return <ChainGlyph asset={GLYPH[asset]} size={size} />;
}

const ArrowDown = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v15m-6-6 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
);

function Foot({ phase, error, idle, busy, done, disabled, onAction, onClose, receipts }: {
  phase: Phase; error: string | null; idle: ReactNode; busy: string; done: ReactNode; disabled: boolean;
  onAction: () => void; onClose: () => void; receipts: Receipt[];
}) {
  return (
    <div className="ms-foot">
      {phase === "error" && error && <p className="status err" role="alert">{error}</p>}
      {phase === "busy" ? (
        <Busy>{busy}</Busy>
      ) : phase === "done" ? (
        <>
          <div className="status ok" role="status"><CheckIcon /> {done}</div>
          <Button block onClick={onClose}>Done</Button>
        </>
      ) : (
        <Button variant="money" size="lg" block disabled={disabled} onClick={onAction}>{idle}</Button>
      )}
      <Receipts items={receipts} />
    </div>
  );
}

/* ——— Redeem ——— */

export type PayLine = {
  id: string;
  asset: Asset3;
  /** "Your SOL Position" / "Won · Ab12…Cd34" */
  from: string;
  gemas: number;
  payout: number;
  /** The payout is an estimate (no live rate read for it). */
  approx: boolean;
  /** Pays out on its own chain a few minutes after the Solana step. */
  later: boolean;
};
export type RedeemModel = {
  lines: PayLine[];
  phase: Phase;
  error: string | null;
  paid: string[];
  receipts: Receipt[];
  canSign: boolean;
  onRedeem: (ids: string[]) => void;
  onClose: () => void;
};

function withPState(m: RedeemModel, p: PState): RedeemModel {
  if (p === "live") return m;
  const ids = m.lines.map((l) => l.id);
  return {
    ...m,
    phase: p === "error" ? "error" : p,
    error: p === "error" ? "Your wallet did not sign. Nothing was redeemed." : m.error,
    paid: p === "done" ? ids : p === "busy" ? ids.slice(0, 1) : m.paid,
    receipts: p === "done" ? [{ label: "redeem", sig: "4kq9Zx2PwQe8nV1sR7tYb3LmC5dF6gH8jK9" }] : m.receipts,
  };
}

const sum = (ls: PayLine[]) => ls.reduce((s, l) => s + l.gemas, 0);
const payText = (l: PayLine) => `${l.approx ? "≈ " : ""}${fmtPay(l.payout, l.asset)} sim${l.asset}`;

export function RedeemProto({ model, now }: { model: RedeemModel; now: ReactNode }) {
  const v = useSheetVariant();
  const m = withPState(model, usePState());
  const body =
    v === "now" ? now : m.lines.length === 0 && m.phase !== "done" ? <RedeemEmpty onClose={m.onClose} /> :
    v === "A" ? <RedeemA m={m} /> : v === "B" ? <RedeemB m={m} /> : v === "C" ? <RedeemC m={m} /> : <RedeemD m={m} />;
  return (
    <>
      {body}
      <ProtoBar />
    </>
  );
}

function RedeemEmpty({ onClose }: { onClose: () => void }) {
  return (
    <div className="ms-empty">
      <span className="ms-empty-mark"><GemaMark size={34} /></span>
      <b>Nothing to redeem yet</b>
      <p className="meta">Gemas become redeemable as their Source Position earns yield. Check back in a few minutes.</p>
      <SimulatedYieldLabel align="center" />
      <Button block onClick={onClose}>Close</Button>
    </div>
  );
}

function redeemFoot(m: RedeemModel, ids: string[], total: number) {
  return (
    <Foot
      phase={m.phase}
      error={m.error}
      idle={<>Redeem <GemaAmount value={total} size="md" /></>}
      busy={`Paying out ${m.paid.length + 1} of ${ids.length}…`}
      done={<>Redeemed {fmtGemas(total)} Gemas</>}
      disabled={!m.canSign || total === 0}
      onAction={() => m.onRedeem(ids)}
      onClose={m.onClose}
      receipts={m.receipts}
    />
  );
}

/* A · Payout slip */
function RedeemA({ m }: { m: RedeemModel }) {
  const total = sum(m.lines);
  const nowLines = m.lines.filter((l) => !l.later);
  const later = m.lines.filter((l) => l.later);
  const group = (title: string, ls: PayLine[], tag: ReactNode) =>
    ls.length > 0 && (
      <div className="ms-a-group">
        <span className="ms-a-gtitle">{title}</span>
        {ls.map((l) => (
          <div key={l.id} className={`ms-a-line${m.paid.includes(l.id) ? " paid" : ""}`}>
            <span className="ms-a-glyph cut"><Glyph asset={l.asset} size={20} /></span>
            <span className="ms-a-what">
              <b>{payText(l)}</b>
              <small>{l.from} · <GemaAmount value={l.gemas} size="sm" /></small>
            </span>
            <span className="ms-a-tag">{m.paid.includes(l.id) ? <><CheckIcon /> Paid</> : tag}</span>
          </div>
        ))}
      </div>
    );
  return (
    <div className="ms-a">
      <div className="ms-a-slip cut">
        <div className="ms-a-top">
          <span className="label">You redeem</span>
          <b className="ms-a-fig"><GemaMark size={34} glint /> {fmtGemas(total)}</b>
          <span className="meta">≈ {fmtUsd(gemasToUsd(total))} at issuance · {m.lines.length} {m.lines.length === 1 ? "Source" : "Sources"}</span>
        </div>
        <div className="ms-a-perf" aria-hidden="true" />
        <div className="ms-a-pay">
          <span className="label">You receive</span>
          {group("In your wallet now", nowLines, "Now")}
          {group("On its own chain", later, <><ClockIcon /> ~5 min</>)}
        </div>
      </div>
      <SimulatedYieldLabel />
      {redeemFoot(m, m.lines.map((l) => l.id), total)}
    </div>
  );
}

/* B · Exchange */
function RedeemB({ m }: { m: RedeemModel }) {
  const total = sum(m.lines);
  const byAsset = (["SOL", "ETH", "HYPE"] as Asset3[])
    .map((a) => ({ a, ls: m.lines.filter((l) => l.asset === a) }))
    .filter((g) => g.ls.length > 0);
  return (
    <div className="ms-b">
      <div className="ms-b-pair">
        <div className="ms-b-panel cut">
          <div className="ms-b-head"><span className="label">You give</span><span className="meta">All redeemable</span></div>
          <div className="ms-b-give"><GemaMark size={30} glint /><b>{fmtGemas(total)}</b><span>Gemas</span></div>
        </div>
        <span className="ms-b-swap cut" aria-hidden="true"><ArrowDown /></span>
        <div className="ms-b-panel get cut">
          <div className="ms-b-head"><span className="label">You get</span><span className="meta">≈ {fmtUsd(gemasToUsd(total))}</span></div>
          {byAsset.map(({ a, ls }) => {
            const pay = ls.reduce((s, l) => s + l.payout, 0);
            const later = ls.some((l) => l.later);
            return (
              <div key={a} className="ms-b-asset">
                <Glyph asset={a} size={28} />
                <span className="ms-b-amt"><b>{ls.some((l) => l.approx) ? "≈ " : ""}{fmtPay(pay, a)}</b> sim{a}</span>
                <span className="ms-b-when">{later ? <><ClockIcon /> on {CHAIN[a]}, ~5 min</> : <>to your wallet, now</>}</span>
              </div>
            );
          })}
        </div>
      </div>
      <details className="ms-b-from">
        <summary>From {m.lines.length} {m.lines.length === 1 ? "Source" : "Sources"}</summary>
        <dl className="kv">
          {m.lines.map((l) => (
            <div key={l.id} style={{ display: "contents" }}>
              <dt className="hstack"><Glyph asset={l.asset} size={14} /> {l.from}</dt>
              <dd>{fmtGemas(l.gemas)} → {payText(l)}</dd>
            </div>
          ))}
        </dl>
      </details>
      <SimulatedYieldLabel />
      {redeemFoot(m, m.lines.map((l) => l.id), total)}
    </div>
  );
}

/* C · Pick Sources */
function RedeemC({ m }: { m: RedeemModel }) {
  const [on, setOn] = useState<string[]>(() => m.lines.map((l) => l.id));
  const picked = m.lines.filter((l) => on.includes(l.id));
  const total = sum(picked);
  const all = picked.length === m.lines.length;
  const locked = m.phase === "busy" || m.phase === "done";
  return (
    <div className="ms-c">
      <div className="ms-c-tools">
        <span className="label">Choose what to redeem</span>
        <button type="button" className="ms-link" disabled={locked} onClick={() => setOn(all ? [] : m.lines.map((l) => l.id))}>
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="ms-c-list">
        {m.lines.map((l) => {
          const checked = on.includes(l.id);
          const paid = m.paid.includes(l.id) && checked;
          return (
            <label key={l.id} className={`ms-c-card cut${checked ? " on" : ""}${paid ? " paid" : ""}`}>
              <input type="checkbox" checked={checked} disabled={locked} onChange={() => setOn((o) => (checked ? o.filter((x) => x !== l.id) : [...o, l.id]))} />
              <span className="ms-c-tick" aria-hidden="true">{checked && <CheckIcon />}</span>
              <span className="ms-c-chain cut" aria-hidden="true"><Glyph asset={l.asset} size={22} /></span>
              <span className="ms-c-txt">
                <b>{l.from}</b>
                <small>{paid ? "Paid" : `${payText(l)} · ${l.later ? `on ${CHAIN[l.asset]}, ~5 min` : "now"}`}</small>
              </span>
              <GemaAmount value={l.gemas} size="lg" />
            </label>
          );
        })}
      </div>
      <div className="ms-c-sum">
        <span>{picked.length} of {m.lines.length} {m.lines.length === 1 ? "Source" : "Sources"}</span>
        <GemaAmount value={total} size="lg" />
      </div>
      <SimulatedYieldLabel />
      {redeemFoot(m, picked.map((l) => l.id), total)}
    </div>
  );
}

/* D · Route */
function RedeemD({ m }: { m: RedeemModel }) {
  const total = sum(m.lines);
  const firstOpen = m.lines.find((l) => !m.paid.includes(l.id))?.id;
  return (
    <div className="ms-d">
      <div className="ms-d-sum">
        <GemaAmount value={total} size="xl" glint />
        <span className="meta">become {m.lines.length} {m.lines.length === 1 ? "payout" : "payouts"} · ≈ {fmtUsd(gemasToUsd(total))}</span>
      </div>
      <ol className="ms-d-route">
        {m.lines.map((l) => {
          const paid = m.paid.includes(l.id);
          const active = m.phase === "busy" && l.id === firstOpen;
          const crossing = paid && l.later;
          const st = crossing ? "crossing" : paid ? "paid" : active ? "active" : "ready";
          return (
            <li key={l.id} className={st}>
              <span className="ms-d-node cut">{st === "paid" ? <CheckIcon /> : st === "active" ? <span className="spinner" /> : <Glyph asset={l.asset} size={18} />}</span>
              <span className="ms-d-txt">
                <b>{payText(l)}</b>
                <small>{l.from} · {fmtGemas(l.gemas)} Gemas{l.later ? ` · pays on ${CHAIN[l.asset]}` : ""}</small>
              </span>
              <span className="ms-d-state">
                {st === "paid" ? "Paid" : st === "active" ? "Paying…" : st === "crossing" ? <><ClockIcon /> Crossing chains</> : l.later ? "~5 min" : "Instant"}
              </span>
            </li>
          );
        })}
      </ol>
      <SimulatedYieldLabel />
      {redeemFoot(m, m.lines.map((l) => l.id), total)}
    </div>
  );
}

/* ——— Return ——— */

export type ReturnSource = { id: string; label: string; max: number; debt: number; issued: number };
export type ReturnModel = {
  asset: Asset3;
  sources: ReturnSource[];
  pick: number;
  onPick: (i: number) => void;
  value: number;
  onChange: (v: number) => void;
  phase: Phase;
  error: string | null;
  returned: number | null;
  receipts: Receipt[];
  canSign: boolean;
  onReturn: () => void;
  onClose: () => void;
};

function withPStateR(m: ReturnModel, p: PState): ReturnModel {
  if (p === "live") return m;
  return {
    ...m,
    phase: p === "error" ? "error" : p,
    error: p === "error" ? "Your wallet did not sign. Nothing was returned." : m.error,
    returned: p === "done" ? m.value : m.returned,
    receipts: p === "done" ? [{ label: "return_own", sig: "3Hd8Kp1VxQ7nB2mZr5Lt9Wc4Ye6Fg8Jh1" }] : m.receipts,
  };
}

export function ReturnProto({ model, now }: { model: ReturnModel; now: ReactNode }) {
  const v = useSheetVariant();
  const m = withPStateR(model, usePState());
  const body =
    v === "now" ? now : m.sources.length === 0 && m.phase !== "done" ? <ReturnEmpty onClose={m.onClose} /> :
    v === "A" ? <ReturnA m={m} /> : v === "B" ? <ReturnB m={m} /> : v === "C" ? <ReturnC m={m} /> : <ReturnD m={m} />;
  return (
    <>
      {body}
      <ProtoBar />
    </>
  );
}

function ReturnEmpty({ onClose }: { onClose: () => void }) {
  return (
    <div className="ms-empty">
      <span className="ms-empty-mark"><GemaMark size={34} /></span>
      <b>No Gemas to return</b>
      <p className="meta">Only your own unspent Gemas from this Position can go back. Won Gemas and Gemas held for Offers stay with you.</p>
      <Button block onClick={onClose}>Close</Button>
    </div>
  );
}

function returnFoot(m: ReturnModel, src: ReturnSource) {
  const clears = m.value >= src.debt;
  return (
    <Foot
      phase={m.phase}
      error={m.error}
      idle={<>Return <GemaAmount value={m.value} size="md" /></>}
      busy="Returning your Gemas…"
      done={<>Returned {fmtGemas(m.returned ?? m.value)} Gemas{clears ? " · Debt cleared" : " · Debt lowered"}</>}
      disabled={!m.canSign || m.value === 0}
      onAction={m.onReturn}
      onClose={m.onClose}
      receipts={m.receipts}
    />
  );
}

function SourcePick({ m, className }: { m: ReturnModel; className?: string }) {
  if (m.sources.length < 2) return null;
  return (
    <div className={`ms-seg ${className ?? ""}`} role="radiogroup" aria-label="Advance to return to">
      {m.sources.map((s, i) => (
        <button key={s.id} type="button" role="radio" aria-checked={i === m.pick} className="cut" onClick={() => m.onPick(i)}>
          {s.label} <small>{fmtGemas(s.debt)} Debt</small>
        </button>
      ))}
    </div>
  );
}

const lockLine = (after: number) =>
  after <= 0 ? "Debt cleared: your Position unlocks." : `${fmtGemas(after)} Gemas of Debt left before your Position unlocks.`;

/* A · Payout slip */
function ReturnA({ m }: { m: ReturnModel }) {
  const src = m.sources[m.pick];
  const after = Math.max(0, src.debt - m.value);
  return (
    <div className="ms-a">
      <SourcePick m={m} />
      <div className="ms-a-slip cut">
        <div className="ms-a-top">
          <span className="label">You return</span>
          <b className="ms-a-fig"><GemaMark size={34} glint /> {fmtGemas(m.value)}</b>
          <span className="meta">of {fmtGemas(src.max)} unspent from this {m.asset} Position</span>
        </div>
        <Slider label="Gemas to return" value={m.value} min={0} max={src.max} onChange={m.onChange} display={<GemaAmount value={m.value} size="md" />} minLabel="0" maxLabel={fmtGemas(src.max)} />
        <div className="ms-a-perf" aria-hidden="true" />
        <div className="ms-a-debt">
          <span className="label">Debt on {src.label}</span>
          <div className="ms-a-debtrow">
            <s>{fmtGemas(src.debt)}</s>
            <ArrowDown />
            <b className={after === 0 ? "clear" : undefined}>{fmtGemas(after)}</b>
            <span className="ms-a-minus">−{fmtGemas(Math.min(m.value, src.debt))}</span>
          </div>
          <span className="meta">{lockLine(after)}</span>
        </div>
      </div>
      <SimulatedYieldLabel />
      {returnFoot(m, src)}
    </div>
  );
}

/* B · Exchange */
function ReturnB({ m }: { m: ReturnModel }) {
  const src = m.sources[m.pick];
  const after = Math.max(0, src.debt - m.value);
  const quick = [0.25, 0.5, 0.75, 1];
  return (
    <div className="ms-b">
      <SourcePick m={m} />
      <div className="ms-b-pair">
        <div className="ms-b-panel cut">
          <div className="ms-b-head"><span className="label">You give</span><span className="meta">{fmtGemas(src.max)} unspent</span></div>
          <label className="ms-b-give input-like">
            <GemaMark size={30} glint />
            <input
              inputMode="numeric"
              aria-label="Gemas to return"
              value={fmtGemas(m.value)}
              onChange={(e) => m.onChange(Math.min(src.max, Number(e.target.value.replace(/\D/g, "")) || 0))}
            />
            <span>Gemas</span>
          </label>
          <div className="ms-b-quick">
            {quick.map((q) => {
              const v = Math.floor(src.max * q);
              return (
                <button key={q} type="button" className="cut" aria-pressed={m.value === v} onClick={() => m.onChange(v)}>
                  {q === 1 ? "Max" : `${q * 100}%`}
                </button>
              );
            })}
          </div>
        </div>
        <span className="ms-b-swap cut" aria-hidden="true"><ArrowDown /></span>
        <div className="ms-b-panel get cut">
          <div className="ms-b-head"><span className="label">Debt goes to</span><span className="meta">now {fmtGemas(src.debt)}</span></div>
          <div className="ms-b-give"><b className={after === 0 ? "clear" : undefined}>{fmtGemas(after)}</b><span>Gemas</span></div>
          <span className="ms-b-when">{after === 0 ? <><CheckIcon /> Your Position unlocks</> : <>Position stays locked until Debt is 0</>}</span>
        </div>
      </div>
      <SimulatedYieldLabel />
      {returnFoot(m, src)}
    </div>
  );
}

/* C · Pick Sources: the picked Advance opens with its own slider */
function ReturnC({ m }: { m: ReturnModel }) {
  return (
    <div className="ms-c">
      <div className="ms-c-tools"><span className="label">Return to which Advance</span></div>
      <div className="ms-c-list" role="radiogroup">
        {m.sources.map((s, i) => {
          const on = i === m.pick;
          const v = on ? m.value : 0;
          const repaid = (s.issued - s.debt) / s.issued;
          const preview = Math.min(v, s.debt) / s.issued;
          return (
            <div key={s.id} className={`ms-c-card ms-c-open cut${on ? " on" : ""}`}>
              <button type="button" role="radio" aria-checked={on} className="ms-c-row" onClick={() => m.onPick(i)}>
                <span className="ms-c-tick round" aria-hidden="true">{on && <i />}</span>
                <span className="ms-c-txt">
                  <b>{s.label}</b>
                  <small>{fmtGemas(s.debt)} of {fmtGemas(s.issued)} Gemas still owed</small>
                </span>
                <span className="ms-c-max">{fmtGemas(s.max)} <small>unspent</small></span>
              </button>
              <div className="ms-c-meter" aria-hidden="true" style={{ ["--r" as string]: repaid, ["--p" as string]: preview }}>
                <i className="r" /><i className="p" />
              </div>
              {on && (
                <div className="ms-c-inline">
                  <Slider label="Gemas to return" value={m.value} min={0} max={s.max} onChange={m.onChange} display={<GemaAmount value={m.value} size="md" />} minLabel="0" maxLabel={fmtGemas(s.max)} />
                  <span className="meta">{lockLine(Math.max(0, s.debt - m.value))}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SimulatedYieldLabel />
      {returnFoot(m, m.sources[m.pick])}
    </div>
  );
}

/* D · Unlock ring */
const OCT = "M60 5H88L115 32V88L88 115H32L5 88V32L32 5Z";
function ReturnD({ m }: { m: ReturnModel }) {
  const src = m.sources[m.pick];
  const after = Math.max(0, src.debt - m.value);
  const r = ((src.issued - src.debt) / src.issued) * 100;
  const p = (Math.min(m.value, src.debt) / src.issued) * 100;
  return (
    <div className="ms-d">
      <SourcePick m={m} />
      <div className="ms-d-ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <path d={OCT} pathLength={100} className="track" />
          <path d={OCT} pathLength={100} className="repaid" strokeDasharray={`${r} 100`} />
          <path d={OCT} pathLength={100} className="preview" strokeDasharray={`${p} 100`} strokeDashoffset={-r} />
        </svg>
        <div className="ms-d-center">
          <span className="label">{after === 0 ? "Unlocked" : "Debt left"}</span>
          <b className={after === 0 ? "clear" : undefined}>{after === 0 ? <CheckIcon /> : fmtGemas(after)}</b>
          <span className="meta">of {fmtGemas(src.issued)} issued</span>
        </div>
      </div>
      <dl className="ms-d-legend">
        <div><dt><i className="repaid" /> Already repaid</dt><dd>{fmtGemas(src.issued - src.debt)}</dd></div>
        <div><dt><i className="preview" /> You return</dt><dd>{fmtGemas(Math.min(m.value, src.debt))}</dd></div>
      </dl>
      <Slider label="Gemas to return" value={m.value} min={0} max={src.max} onChange={m.onChange} display={<GemaAmount value={m.value} size="md" />} minLabel="0" maxLabel={fmtGemas(src.max)} />
      <span className="meta">{lockLine(after)}</span>
      <SimulatedYieldLabel />
      {returnFoot(m, src)}
    </div>
  );
}
