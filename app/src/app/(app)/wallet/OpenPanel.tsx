"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import { Button, ChainGlyph, Slider } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { Chain, GameId } from "@/lib/mock/types";
import { UnlockTrack, YieldFeeNote, YieldToGemas, monthsLabel } from "./AdvanceQuote";
import "./wallet.css";

export const CHAINS: Chain[] = ["SOL", "ETH", "HYPE"];

/** The game a Player was sent from (`/wallet?open=1&need=<entry>&game=<slug>`), so the sheet can size the deposit and lead back. */
export type OpenIntent = { game: GameId; need: number | null };
export const OpenIntentContext = createContext<OpenIntent | null>(null);
export const useOpenIntent = () => useContext(OpenIntentContext);

/** The sheet's lead line when a game sent the Player here. */
function IntentNote({ intent }: { intent: OpenIntent }) {
  const { gemas } = useAccount();
  const name = GAME_NAMES[intent.game];
  if (!intent.need) return <p className="wl-intent">Get Gemas to play {name}.</p>;
  const short = Math.max(0, intent.need - gemas.available);
  return (
    <p className="wl-intent">
      You need <b>{fmtGemas(intent.need)} Gemas</b> for {name}.
      {gemas.available > 0 && short > 0 && <span className="meta"> You have {fmtGemas(gemas.available)}, {fmtGemas(short)} to go.</span>}
    </p>
  );
}

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const PRESETS: [string, number][] = [["25%", 0.25], ["50%", 0.5], ["Max", 1]];

/**
 * The OPEN A POSITION form body, built like the Take an Advance sheet but led by the deposit: an editable
 * "Lock SOL · New Position" card where that sheet has its locked Position, then yield → Gemas, the Horizon,
 * Now → Unlock Estimate and the money button.
 */
export function OpenFormView({
  chain,
  apy,
  amountText,
  onAmount,
  amountInvalid = false,
  balance,
  max,
  months,
  onMonths,
  gemas,
  yieldText,
  estimate,
  arrival = "Lock starts, Gemas in your balance",
  yieldFeeBps,
  details,
  alerts,
  note,
  buttonLabel,
  disabled,
  onSubmit,
  head,
  inert = false,
}: {
  chain: Chain;
  /** "7% APY", once known. */
  apy?: string;
  amountText: string;
  onAmount: (v: string) => void;
  amountInvalid?: boolean;
  /** Under the amount: the balance and how to get more. */
  balance?: ReactNode;
  /** The balance as a number: shows 25% / 50% / Max. */
  max?: number;
  months: number;
  onMonths: (m: number) => void;
  gemas: number | null;
  /** The Position's yield over the Horizon, with its unit. */
  yieldText: string;
  estimate: string;
  /** What happens now, on the left of the Unlock line. */
  arrival?: string;
  /** The Yield Fee a later cash-out of these Gemas pays (the launch rate while the Treasury is unread). */
  yieldFeeBps?: number;
  details?: [string, ReactNode][];
  alerts?: ReactNode;
  note?: ReactNode;
  buttonLabel: ReactNode;
  disabled: boolean;
  onSubmit: () => void;
  head?: ReactNode;
  /** No market yet: the form shows its shape but cannot be edited. */
  inert?: boolean;
}) {
  const id = useId();
  const presets = !inert && max !== undefined;
  return (
    <div className="wl-open-form">
      {head}
      <div className={`cut cut-card wl-deposit${amountInvalid ? " bad" : ""}`}>
        <div className="wl-deposit-head">
          <ChainGlyph asset={GLYPH[chain]} size={30} />
          <div>
            <label htmlFor={id}>Lock {chain}</label>
            <span className="meta">{apy ? `${apy} · ` : ""}locked, never played</span>
          </div>
          <span className="wl-new">New Lock</span>
        </div>
        <div className="wl-amount">
          <input id={id} inputMode="decimal" placeholder="0" value={amountText} disabled={inert} onChange={(e) => onAmount(e.target.value)} aria-invalid={amountInvalid} />
          <span>{chain}</span>
        </div>
        {(balance || presets) && (
          <div className="wl-deposit-foot">
            {balance && <div className="meta wl-balance">{balance}</div>}
            {presets && (
              <div className="wl-presets">
                {PRESETS.map(([label, f]) => (
                  <button key={label} type="button" className="cut cut-chip" disabled={!max} onClick={() => onAmount(String(Math.floor((max ?? 0) * f * 1000) / 1000))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <YieldToGemas months={months} yieldText={yieldText} gemas={gemas ?? 0} yieldFeeBps={yieldFeeBps} showFee={false} />
      <Slider label="Length" value={months} min={1} max={12} onChange={onMonths} display={monthsLabel(months)} format={(m) => `${m}`} />
      <UnlockTrack now={arrival} unlock={estimate} end={`Unlock Estimate, your ${chain} back`} />
      <p className="wl-lede">
        You get Gemas now from your future yield. {estimate !== "—" ? <>Your {chain} comes back on <b>{estimate}</b>.</> : <>Your {chain} comes back when your Length ends.</>}
      </p>
      {alerts}
      {note && <p className="note">{note}</p>}
      <div className="wl-cta">
        <Button variant="money" size="lg" block disabled={disabled} onClick={onSubmit}>
          {buttonLabel}
        </Button>
      </div>
      <details className="wl-details">
        <summary>Quote details</summary>
        {details && (
          <dl className="kv">
            {details.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <YieldFeeNote yieldFeeBps={yieldFeeBps} />
      </details>
    </div>
  );
}

/** Chain tabs + the active chain's form. */
export function OpenPanel({ tab, onTab, children }: { tab: Chain; onTab: (c: Chain) => void; children: ReactNode }) {
  const intent = useOpenIntent();
  return (
    <section className="wl-open" id="open-position" aria-label="Get Gemas">
      {intent && <IntentNote intent={intent} />}
      <div className="wl-tabs" role="tablist" aria-label="Chain">
        {CHAINS.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={tab === c} className={`cut cut-card${tab === c ? " on" : ""}`} onClick={() => onTab(c)}>
            {c}
          </button>
        ))}
      </div>
      <div role="tabpanel">{children}</div>
    </section>
  );
}
