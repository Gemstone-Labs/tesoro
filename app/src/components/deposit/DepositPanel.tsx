"use client";

import Image from "next/image";
import { Info } from "lucide-react";
import { Busy, Button, CheckIcon, GemaAmount, GemaMark } from "@/components/ui";
import { DEPOSIT_ACK_CONFIRM, DEPOSIT_ACK_POINTS, DEPOSIT_ACK_TITLE } from "@/lib/deposit/acknowledgment";
import { PACK_MONTHS, type DepositPack, type DepositPackId, type PackQuote } from "@/lib/deposit/packs";
import { fmtGemas, fmtUsd } from "@/lib/format";
import "./deposit.css";

/** The two art sets the founders are comparing: A = piles of Gemas, B = pouch, case and vault safe. */
export type DepositArt = "a" | "b";
export const artSrc = (art: DepositArt, id: DepositPackId) => `/art/deposit/${art}-${id}.webp`;

/** Test mode only: the line that says the money is not real and how fast time runs. */
export function TestModeLine({ hours }: { hours: number }) {
  return <p className="dep-test">Test mode · no card needed · {PACK_MONTHS} months = about {hours} {hours === 1 ? "hour" : "hours"}</p>;
}

export interface PacksViewProps {
  /** Null while the SOL price is not available to quote on. */
  quotes: PackQuote[] | null;
  /** The pack a game sent the Player for. */
  highlight: DepositPackId | null;
  art: DepositArt;
  /** Shows the A/B switch (only while the founders pick). */
  onArt?: (art: DepositArt) => void;
  /** A way to pay exists; false on mainnet until a card provider is connected. */
  canPay: boolean;
  testMode: boolean;
  /** The fee taken from the deposit, percent; 0 hides the line. */
  feePct: number;
  /** The pack whose acknowledgment is being looked up. */
  checking: DepositPackId | null;
  onPick: (id: DepositPackId) => void;
  onAdvanced?: () => void;
}

export function PacksView({ quotes, highlight, art, onArt, canPay, testMode, feePct, checking, onPick, onAdvanced }: PacksViewProps) {
  return (
    <div className="dep">
      <p className="dep-lead">Deposit money, get Gemas to play. 1 Gema = $0.01.</p>
      <div className="dep-packs" role="group" aria-label="Deposit packs">
        {(quotes ?? PLACEHOLDER).map((q) => {
          const hot = highlight === q.pack.id;
          const ready = quotes !== null && q.gemas > 0;
          return (
            <article key={q.pack.id} className={`cut cut-card dep-card${hot ? " hot" : ""}`} aria-label={`${q.pack.name} pack`}>
              {hot && <span className="dep-tag">Covers your entry</span>}
              <Image className="dep-art" src={artSrc(art, q.pack.id)} width={512} height={512} alt="" sizes="(max-width: 639px) 96px, 172px" />
              <h3 className="dep-name">{q.pack.name}</h3>
              <p className="dep-gemas">
                <b>
                  <GemaMark size={26} />
                  {ready ? `≈ ${fmtGemas(q.gemas)}` : "—"}
                </b>
                <span>Gemas</span>
              </p>
              <Button
                variant="money"
                size="lg"
                disabled={!canPay || !ready || checking !== null}
                onClick={() => onPick(q.pack.id)}
                aria-label={canPay ? `Deposit ${fmtUsd(q.pack.usd)}, ${q.pack.name} pack` : "Card deposits coming soon"}
              >
                {!canPay ? "Card deposits coming soon" : checking === q.pack.id ? "One moment…" : `Deposit ${fmtUsd(q.pack.usd)}`}
              </Button>
            </article>
          );
        })}
      </div>

      <div className="dep-small">
        <p className="dep-back">You get your deposit back after about {PACK_MONTHS} months!</p>
        <p className="note dep-info">
          <Info aria-hidden="true" />
          <span>What you get back depends on the SOL price when you withdraw.</span>
        </p>
        {feePct > 0 && <p className="note">Includes a {feePct}% card fee, taken from your deposit.</p>}
        {quotes === null && <p className="note" role="status">Updating the SOL price. Packs show in a moment.</p>}
        {!canPay && (
          <p className="dep-soon">
            Prefer to use crypto?{" "}
            <button type="button" className="dep-link" onClick={onAdvanced}>Open the Advanced view</button>.
          </p>
        )}
        {testMode && <TestModeLine hours={(PACK_MONTHS * 10) / 60} />}
        {onArt && (
          <p className="dep-art-pick" role="group" aria-label="Pack art">
            Art
            {(["a", "b"] as const).map((k) => (
              <button key={k} type="button" className="cut cut-chip" aria-pressed={art === k} onClick={() => onArt(k)}>
                Art {k.toUpperCase()}
              </button>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

const PLACEHOLDER: PackQuote[] = [
  { pack: { id: "starter", name: "Starter", usd: 100 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
  { pack: { id: "player", name: "Player", usd: 250 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
  { pack: { id: "pro", name: "Pro", usd: 500 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
];

export function AckView({ pack, checked, onChecked, busy, error, onConfirm, onBack }: {
  pack: DepositPack;
  checked: boolean;
  onChecked: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="dep dep-ack">
      <p className="dep-pack-line">{pack.name} pack · {fmtUsd(pack.usd)}</p>
      <h3>{DEPOSIT_ACK_TITLE}</h3>
      <ul>
        {DEPOSIT_ACK_POINTS.map((p) => (
          <li key={p}>
            <CheckIcon aria-hidden="true" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <label className="dep-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} />
        <span>I have read this and agree.</span>
      </label>
      {error && <p className="status err" role="alert">{error}</p>}
      <div className="dep-actions">
        <Button variant="money" size="lg" block disabled={!checked || busy} onClick={onConfirm}>
          {busy ? "Saving…" : DEPOSIT_ACK_CONFIRM}
        </Button>
        <Button block onClick={onBack} disabled={busy}>Back</Button>
      </div>
    </div>
  );
}

export type WorkPhase = "paying" | "adding";

export function WorkingView({ pack, phase, testMode, hours }: { pack: DepositPack; phase: WorkPhase; testMode: boolean; hours: number }) {
  const steps: { id: WorkPhase; label: string }[] = [
    { id: "paying", label: testMode ? "Getting your test SOL" : "Waiting for your payment" },
    { id: "adding", label: "Adding your deposit and your Gemas" },
  ];
  const at = steps.findIndex((s) => s.id === phase);
  return (
    <div className="dep">
      <p className="dep-pack-line">{pack.name} pack · {fmtUsd(pack.usd)}</p>
      <ol className="dep-steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s.id} className={i < at ? "done" : undefined} aria-current={i === at ? "step" : undefined}>
            {i < at ? <CheckIcon aria-label="Done" /> : i === at ? <span className="spinner" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
      <Busy>{phase === "paying" ? "This takes a few seconds." : "Almost there. Don't close this window."}</Busy>
      {testMode && <TestModeLine hours={hours} />}
    </div>
  );
}

export function DoneView({ gemas, back, onDone, testMode, hours }: {
  gemas: number;
  back: { href: string; label: string; need: number } | null;
  onDone: () => void;
  testMode: boolean;
  hours: number;
}) {
  return (
    <div className="dep-done">
      <p className="status ok" role="status">
        <CheckIcon aria-hidden="true" /> Deposit added
      </p>
      <b className="dep-done-fig">
        <GemaAmount value={gemas} sign size="xl" glint />
        <span className="sr-only">Gemas added</span>
      </b>
      <p>Your Gemas are ready to play. Your deposit waits in your Vault and comes back after about {PACK_MONTHS} months.</p>
      <div className="dep-actions">
        {back && (
          <Button variant="money" size="lg" block href={back.href} onClick={onDone}>
            {back.label}
            {back.need > 0 && (
              <>
                {" · "}
                <GemaMark size={18} /> {fmtGemas(back.need)}
              </>
            )}
          </Button>
        )}
        <Button block variant={back ? "neutral" : "money"} size={back ? "md" : "lg"} onClick={onDone}>
          {back ? "Not now" : "Done"}
        </Button>
      </div>
      {testMode && <TestModeLine hours={hours} />}
    </div>
  );
}

export function ErrorView({ pack, message, paidAlready, onRetry, onClose }: {
  pack: DepositPack;
  message: string;
  /** The money arrived before it failed: trying again only finishes the deposit. */
  paidAlready: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="dep dep-error">
      <p className="dep-pack-line">{pack.name} pack · {fmtUsd(pack.usd)}</p>
      <p className="status err" role="alert">{message}</p>
      {paidAlready && <p className="note">Your payment went through. Trying again only finishes adding your deposit.</p>}
      <div className="dep-actions">
        <Button variant="money" size="lg" block onClick={onRetry}>Try again</Button>
        <Button block onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
