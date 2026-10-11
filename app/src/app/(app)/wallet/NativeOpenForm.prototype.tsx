"use client";

/**
 * PROTOTYPE ONLY. Takes on the SOL "Open a Position" form (`NativeOpenForm`), switched by
 * `?variant=now|A|B|C` (floating bar). Round 2 (founder: keep the 1–12 month slider; look like the
 * Take an Advance sheet, but clearly different). Same data and open action in every take.
 *
 *   A  Deposit on top — an editable "Lock SOL · New Position" card where the Advance sheet has its
 *                       locked Position row; the Advance sheet's yield → Gemas, slider and track below
 *   B  Downward flow  — wallet ↓ new locked Position (slider inside) ↓ You get now, top to bottom
 *   C  Two steps      — 1 Lock (amount only) → 2 the Advance layout on a "New" Position row
 */
import { useId, useState, type ReactNode } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Button, ChainGlyph, CountUp, GemaMark, Slider } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtWhen } from "@/lib/format";
import { getTestSimSol } from "@/lib/chain/native-flow";
import type { NativeMarket } from "@/lib/chain/native";
import "./advance-sheet.css";
import "./native-open.prototype.css";

export const NOF_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Deposit on top" },
  { key: "B", name: "Downward flow" },
  { key: "C", name: "Two steps" },
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
  gemasFor: (m: number) => number;
  unlockFor: (m: number) => number;
};

const fmt3 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const mo = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;
const amountSol = (m: OpenModel) => (Number(m.text) > 0 ? fmt3(Number(m.text)) : "0");

/** Balance + Get test simSOL as one quiet line. */
function Faucet({ m }: { m: OpenModel }) {
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
    <span className="nof-faucet meta">
      {m.loading ? "Loading your Account…" : <>You have <b className="tnum">{m.market ? fmt3(m.balance) : "—"}</b> simSOL</>}
      <span aria-hidden="true"> · </span>
      <button type="button" className="nof-link" disabled={!auth.signer || busy !== null} onClick={get}>
        {busy ? `${busy}…` : "Get test simSOL"}
      </button>
    </span>
  );
}

function Presets({ m }: { m: OpenModel }) {
  if (!m.market || m.balance <= 0) return null;
  const set = (f: number) => m.setText(String(Math.floor(m.balance * f * 1000) / 1000));
  return (
    <div className="nof-presets">
      {([["25%", 0.25], ["50%", 0.5], ["Max", 1]] as const).map(([l, f]) => (
        <button key={l} type="button" className="cut cut-chip nof-preset" onClick={() => set(f)}>{l}</button>
      ))}
    </div>
  );
}

function AmountInput({ m, id, big = false }: { m: OpenModel; id: string; big?: boolean }) {
  return (
    <div className={`nof-amt${big ? " big" : ""}${m.tooMuch ? " bad" : ""}`}>
      <input id={id} inputMode="decimal" placeholder="0" value={m.text} disabled={!m.market} onChange={(e) => m.setText(e.target.value)} aria-invalid={m.tooMuch} />
      <span>SOL</span>
    </div>
  );
}

function Horizon({ m }: { m: OpenModel }) {
  return <Slider label="Horizon" value={m.months} min={1} max={12} onChange={m.setMonths} display={mo(m.months)} format={(v) => `${v}`} />;
}

/** The Advance sheet's "yield over N months ››› You get now" pair. */
function YieldToGemas({ m }: { m: OpenModel }) {
  return (
    <div className="adv-swap">
      <div className="adv-in">
        <span className="label">Yield over {mo(m.months)}</span>
        <b>{m.yieldSol} SOL</b>
      </div>
      <svg className="adv-flow" viewBox="0 0 44 16" aria-hidden>
        <path d="M4 3l5 5-5 5M17 3l5 5-5 5M30 3l5 5-5 5" />
      </svg>
      <div className="adv-out cut cut-card">
        <span className="label">You get now</span>
        <span className="adv-fig">
          <GemaMark size={26} />
          {m.gemas > 0 ? <CountUp value={m.gemas} duration={400} /> : "0"}
        </span>
        <span className="adv-usd">{m.gemas > 0 ? m.usd : "—"}</span>
      </div>
    </div>
  );
}

/** The Advance sheet's Now → Unlock track, worded for a new Position: the SOL comes back at the end. */
function Track({ m }: { m: OpenModel }) {
  return (
    <div className="adv-track">
      <span><b>Now</b> Position opens, Gemas in your balance</span>
      <span className="adv-track-line" aria-hidden />
      <span><b>{m.estimateMs ? fmtWhen(m.estimateMs) : "—"}</b> Unlock Estimate, your SOL back</span>
    </div>
  );
}

function Foot({ m }: { m: OpenModel }) {
  return (
    <>
      {m.alerts}
      <span className="sim">Simulated yield · 1 month = 10 min</span>
      <Button variant="money" size="lg" block disabled={m.disabled} onClick={m.submit}>
        {m.buttonLabel}
      </Button>
      <details className="wl-details">
        <summary>Quote details</summary>
        <dl className="kv">
          <dt>Worth at issuance</dt><dd>{m.usd}</dd>
          <dt>Principal</dt><dd>{m.principalSol} SOL</dd>
          <dt>Projected yield</dt><dd>{m.yieldSol} SOL</dd>
          <dt>Price feed</dt><dd>{m.priceLine}</dd>
        </dl>
      </details>
    </>
  );
}

// ---- A · Deposit on top --------------------------------------------------------------------------

function VariantA({ m }: { m: OpenModel }) {
  const id = useId();
  return (
    <div className="adv nof">
      <div className="cut cut-card nof-dep">
        <div className="nof-dep-head">
          <ChainGlyph asset={0} size={30} />
          <div>
            <label htmlFor={id}><strong>Lock SOL</strong></label>
            <span className="meta">{m.apyPct}% APY · locked, never played</span>
          </div>
          <span className="nof-new">New Position</span>
        </div>
        <AmountInput m={m} id={id} big />
        <div className="nof-dep-foot">
          <Faucet m={m} />
          <Presets m={m} />
        </div>
      </div>
      <YieldToGemas m={m} />
      <Horizon m={m} />
      <Track m={m} />
      <Foot m={m} />
    </div>
  );
}

// ---- B · Downward flow ---------------------------------------------------------------------------

function Down({ money = false }: { money?: boolean }) {
  return (
    <svg className={`nof-down${money ? " money" : ""}`} viewBox="0 0 16 30" aria-hidden>
      <path d="M3 2l5 5 5-5M3 12l5 5 5-5M3 22l5 5 5-5" />
    </svg>
  );
}

function VariantB({ m }: { m: OpenModel }) {
  const id = useId();
  return (
    <div className="adv nof nof-b">
      <section className="nof-b-stage">
        <div className="spread">
          <label className="label" htmlFor={id}>From your wallet</label>
          <Faucet m={m} />
        </div>
        <div className="nof-b-row">
          <AmountInput m={m} id={id} big />
          <Presets m={m} />
        </div>
      </section>
      <Down />
      <section className="cut cut-card nof-b-pos">
        <div className="nof-dep-head">
          <ChainGlyph asset={0} size={30} />
          <div>
            <strong>{amountSol(m)} SOL Position</strong>
            <span className="meta">{m.apyPct}% APY · locked, never played</span>
          </div>
          <Lock size={16} className="adv-lock" aria-hidden />
        </div>
        <Horizon m={m} />
        <div className="nof-b-unlock">
          <LockOpen size={14} aria-hidden />
          <span>Unlock Estimate <b>{m.estimateMs ? fmtWhen(m.estimateMs) : "—"}</b>, your SOL back</span>
        </div>
      </section>
      <Down money />
      <section className="adv-out cut cut-card nof-b-out">
        <div>
          <span className="label">You get now</span>
          <span className="adv-fig">
            <GemaMark size={26} />
            {m.gemas > 0 ? <CountUp value={m.gemas} duration={400} /> : "0"}
          </span>
        </div>
        <div className="nof-b-out-r">
          <span className="adv-usd">{m.gemas > 0 ? m.usd : "—"}</span>
          <span className="meta">its yield over {mo(m.months)}: {m.yieldSol} SOL</span>
        </div>
      </section>
      <Foot m={m} />
    </div>
  );
}

// ---- C · Two steps -------------------------------------------------------------------------------

function Stepper({ step, onStep, canNext }: { step: 1 | 2; onStep: (s: 1 | 2) => void; canNext: boolean }) {
  return (
    <ol className="nof-steps">
      <li className={step === 1 ? "on" : "done"}>
        <button type="button" onClick={() => onStep(1)}><span>1</span> Lock SOL</button>
      </li>
      <li className="nof-steps-line" aria-hidden />
      <li className={step === 2 ? "on" : ""}>
        <button type="button" disabled={!canNext} onClick={() => onStep(2)}><span>2</span> Take the Advance</button>
      </li>
    </ol>
  );
}

function VariantC({ m }: { m: OpenModel }) {
  const id = useId();
  const [step, setStep] = useState<1 | 2>(1);
  const canNext = !!m.market && Number(m.text) > 0 && !m.tooMuch;
  return (
    <div className="adv nof nof-c">
      <Stepper step={step} onStep={setStep} canNext={canNext} />
      {step === 1 ? (
        <>
          <div className="nof-c-lock">
            <label className="label" htmlFor={id}>How much SOL to lock</label>
            <AmountInput m={m} id={id} big />
            <div className="nof-dep-foot">
              <Faucet m={m} />
              <Presets m={m} />
            </div>
          </div>
          <ul className="nof-c-facts">
            <li><Lock size={14} aria-hidden /> Your Principal is locked, never played.</li>
            <li><GemaMark size={14} /> Next, take its yield upfront as Gemas.</li>
            <li><LockOpen size={14} aria-hidden /> It unlocks when yield has repaid them.</li>
          </ul>
          {m.tooMuch && <p className="status err" role="alert">That is more simSOL than you have.</p>}
          <Button size="lg" block disabled={!canNext} onClick={() => setStep(2)}>
            Next · choose your Advance
          </Button>
        </>
      ) : (
        <>
          <div className="adv-source cut cut-card nof-c-source">
            <ChainGlyph asset={0} size={30} />
            <div>
              <strong>{amountSol(m)} SOL Position</strong>
              <span className="meta">{m.apyPct}% APY · opens with this Advance</span>
            </div>
            <button type="button" className="nof-link" onClick={() => setStep(1)}>Change</button>
            <span className="nof-new">New</span>
          </div>
          <YieldToGemas m={m} />
          <Horizon m={m} />
          <Track m={m} />
          <Foot m={m} />
        </>
      )}
    </div>
  );
}

export function NativeOpenPrototype({ variant, m }: { variant: Exclude<NofVariant, "now">; m: OpenModel }) {
  if (variant === "A") return <VariantA m={m} />;
  if (variant === "B") return <VariantB m={m} />;
  return <VariantC m={m} />;
}

