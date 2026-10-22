"use client";

import Image from "next/image";
import { ChartColumn, Clock, CreditCard } from "lucide-react";
import { type ReactNode } from "react";
import { Button, CheckIcon, CountUp, GemaMark } from "@/components/ui";
import { DEPOSIT_ACK_CONFIRM, DEPOSIT_ACK_POINTS, DEPOSIT_ACK_SKIP, DEPOSIT_ACK_TITLE } from "@/lib/deposit/acknowledgment";
import { PACK_MONTHS, type DepositPack, type DepositPackId, type PackQuote } from "@/lib/deposit/packs";
import { fmtGemas, fmtUsd } from "@/lib/format";
import "./deposit.css";

export const packArt = (id: DepositPackId) => `/art/deposit/${id}.webp`;

export interface PacksViewProps {
  /** Null while the SOL price is not available to quote on. */
  quotes: PackQuote[] | null;
  /** The pack a game sent the Player for. */
  highlight: DepositPackId | null;
  /** A way to pay exists; false on mainnet until a card provider is connected. */
  canPay: boolean;
  testMode: boolean;
  /** The fee taken from the deposit, percent; 0 hides the line. */
  feePct: number;
  onPick: (id: DepositPackId) => void;
}

const FEATURED: DepositPackId = "player";

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="dep-note">
      <span className="dep-note-icon" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

export function PacksView({ quotes, highlight, canPay, testMode, feePct, onPick }: PacksViewProps) {
  return (
    <div className="dep">
      <div className="dep-packs" role="group" aria-label="Deposit packs">
        {(quotes ?? PLACEHOLDER).map((q) => {
          const id = q.pack.id;
          const ready = quotes !== null && q.gemas > 0;
          const tag = highlight === id ? "Covers your entry" : id === FEATURED ? "Most picked" : null;
          return (
            <article
              key={id}
              className={`cut cut-card dep-card${id === FEATURED ? " feat" : ""}${highlight === id ? " hot" : ""}`}
              aria-label={`${q.pack.name} pack`}
            >
              {tag && <span className={`dep-tag${highlight === id ? " hot" : ""}`}>{tag}</span>}
              <h3 className="dep-name">{q.pack.name}</h3>
              <Image className="dep-art" src={packArt(id)} width={512} height={512} alt="" sizes="(max-width: 639px) 96px, 280px" loading="eager" />
              <p className="dep-gemas">
                <b>
                  <GemaMark size={26} />
                  {ready ? fmtGemas(q.gemas) : "—"}
                </b>
                <span>Gemas</span>
              </p>
              <Button
                variant="money"
                size="lg"
                disabled={!canPay || !ready}
                onClick={() => onPick(id)}
                aria-label={canPay ? `Deposit ${fmtUsd(q.pack.usd)}, ${q.pack.name} pack` : "Card deposits coming soon"}
              >
                {canPay ? `Deposit ${fmtUsd(q.pack.usd)}` : "Card deposits coming soon"}
              </Button>
            </article>
          );
        })}
      </div>

      <ul className="dep-notes">
        <Note icon={<Clock />}>You get your deposit back after about {PACK_MONTHS} months!</Note>
        <Note icon={<ChartColumn />}>What you get back depends on the SOL price when you withdraw.</Note>
        <Note icon={<CreditCard />}>
          {testMode ? (
            <>Test mode · no card needed · {PACK_MONTHS} months = about {(PACK_MONTHS * 10) / 60} hours</>
          ) : canPay ? (
            "Card, Apple Pay or Google Pay"
          ) : (
            "Prefer to use crypto? Turn on Pro view at the top."
          )}
        </Note>
      </ul>
      {(feePct > 0 || quotes === null) && (
        <div className="dep-small">
          {feePct > 0 && <p className="note">Includes a {feePct}% card fee, taken from your deposit.</p>}
          {quotes === null && <p className="note" role="status">Updating the SOL price. Packs show in a moment.</p>}
        </div>
      )}
    </div>
  );
}

const PLACEHOLDER: PackQuote[] = [
  { pack: { id: "starter", name: "Starter", usd: 100 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
  { pack: { id: "player", name: "Player", usd: 250 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
  { pack: { id: "pro", name: "Pro", usd: 500 }, lockLamports: 0n, feeUsd: 0, gemas: 0 },
];

/** "Before you deposit": the four points, numbered, then "Don't show this again" and "I understand". Confirming always records it. */
export function AckView({ dontShow, onDontShow, busy, error, onConfirm }: {
  dontShow: boolean;
  onDontShow: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <div className="dep-ack">
      <p className="dep-ack-title" aria-hidden="true">{DEPOSIT_ACK_TITLE}</p>
      <ol className="dep-ack-points">
        {DEPOSIT_ACK_POINTS.map((p, i) => (
          <li key={p}>
            <span className="cut cut-chip dep-ack-num" aria-hidden="true">{i + 1}</span>
            <p>{p}</p>
          </li>
        ))}
      </ol>
      {error && <p className="status err" role="alert">{error}</p>}
      <div className="dep-ack-foot">
        <label className="dep-check">
          <input type="checkbox" checked={dontShow} onChange={(e) => onDontShow(e.target.checked)} />
          <span>{DEPOSIT_ACK_SKIP}</span>
        </label>
        <Button variant="silver" size="lg" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving…" : DEPOSIT_ACK_CONFIRM}
        </Button>
      </div>
    </div>
  );
}

export type WorkPhase = "paying" | "adding";

export function WorkingView({ pack, gemas, phase, testMode }: { pack: DepositPack; gemas: number; phase: WorkPhase; testMode: boolean }) {
  const paid = phase === "adding";
  const steps = [
    { id: "paying", label: paid ? (testMode ? "Test SOL added" : "Payment received") : testMode ? "Getting your test SOL" : "Waiting for your payment", state: paid ? "done" : "now" },
    { id: "adding", label: "Adding your deposit and your Gemas", state: paid ? "now" : "next" },
  ] as const;
  return (
    <div className="dep-work">
      <Image className="dep-art" src={packArt(pack.id)} width={512} height={512} alt="" sizes="180px" priority />
      <p className="dep-work-title" aria-hidden="true">Adding your deposit</p>
      <p className="dep-work-pack">
        {pack.name} pack · Deposit {fmtUsd(pack.usd)} · {fmtGemas(gemas)} Gemas
      </p>
      <ol className="dep-work-steps" aria-label="Progress">
        {steps.map((s) => (
          <li key={s.id} className={s.state} aria-current={s.state === "now" ? "step" : undefined}>
            <span className="cut cut-chip dep-work-mark" aria-hidden="true">
              {s.state === "done" ? <CheckIcon /> : s.state === "now" ? <span className="spinner" /> : null}
            </span>
            <span>
              {s.label}
              {s.state === "done" && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="dep-work-note" role="status">This takes a few seconds. Don&apos;t close this window.</p>
    </div>
  );
}

export function DoneView({ gemas, packId, back, onDone }: {
  gemas: number;
  packId: DepositPackId;
  /** Where a game that sent the Player goes on; "Play now" otherwise. */
  back: { href: string; label: string; need: number } | null;
  onDone: () => void;
}) {
  const play = back ?? { href: "/play", label: "Play now", need: 0 };
  return (
    <div className="dep-done">
      <h3 className="dep-done-fig">
        <span aria-hidden="true">
          <CountUp value={gemas} from={0} duration={900} format={(n) => `+${fmtGemas(n)}`} /> Gemas
        </span>
        <span className="sr-only">{fmtGemas(gemas)} Gemas added</span>
      </h3>
      <p className="dep-done-ready" role="status">
        <span className="cut cut-chip dep-done-check" aria-hidden="true"><CheckIcon /></span> Your Gemas are ready
      </p>
      <Image className="dep-art" src={packArt(packId)} width={512} height={512} alt="" sizes="(max-width: 639px) 280px, 440px" priority />
      <div className="dep-actions">
        <Button variant="silver" size="lg" block href={play.href} onClick={onDone}>{play.label}</Button>
        <Button variant="neutral" onClick={onDone}>Done</Button>
      </div>
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
