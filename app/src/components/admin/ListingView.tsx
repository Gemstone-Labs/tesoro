"use client";

import { useState } from "react";
import { Button, Select } from "@/components/ui";
import { isFeaturedNow, listingStage, STAGE_LABEL } from "@/lib/listing/state";
import type { GameStanding } from "@/lib/chain/admin-listing";
import type { AdminReply, StudioApplication } from "@/server/listing/service";
import "./review.css";
import "./orders.css";

const day = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

export type ListingAction =
  | { kind: "accept"; note?: string }
  | { kind: "reject"; note?: string }
  | { kind: "pay"; payment: "chain" | "invoice"; reference: string; amountUsd: number; years: number }
  | { kind: "feature"; on: boolean }
  | { kind: "list" };

export interface ListingViewProps {
  reply: AdminReply | null;
  /** Chain standing by program id, for accepted applications. */
  standing?: Record<string, GameStanding>;
  error?: string | null;
  signedOut?: boolean;
  busy?: number | null;
  result?: { id: number; ok: boolean; text: string } | null;
  onAction?: (app: StudioApplication, action: ListingAction) => void;
}

function Payment({ app, yearUsd, busy, onAction }: { app: StudioApplication; yearUsd: number; busy: boolean; onAction?: ListingViewProps["onAction"] }) {
  const [kind, setKind] = useState<"chain" | "invoice">("invoice");
  const [ref, setRef] = useState("");
  const valid = ref.trim().length > 0;
  return (
    <form
      className="od-fill"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onAction?.(app, { kind: "pay", payment: kind, reference: ref.trim(), amountUsd: yearUsd, years: 1 });
      }}
    >
      <label>
        <span className="meta">Paid by</span>
        <Select aria-label="Paid by" value={kind} options={[{ value: "invoice", label: "Invoice" }, { value: "chain", label: "On chain" }]} onChange={setKind} />
      </label>
      <label>
        <span className="meta">{kind === "chain" ? "Transaction signature" : "Invoice number"}</span>
        <input value={ref} onChange={(e) => setRef(e.target.value)} aria-invalid={!valid} />
      </label>
      <Button variant="money" type="submit" disabled={!valid || busy}>
        Record ${yearUsd} for 1 year
      </Button>
    </form>
  );
}

function Card({ app, now, yearUsd, standing, busy, result, onAction }: { app: StudioApplication; now: number; yearUsd: number; standing?: GameStanding; busy: boolean; result: ListingViewProps["result"]; onAction?: ListingViewProps["onAction"] }) {
  const stage = listingStage({ status: app.status, paidUntil: app.paidUntil }, standing?.chain ?? null, standing?.live ?? null, now);
  const mine = result && result.id === app.id ? result : null;
  return (
    <li className="cut cut-card od-order">
      <header className="od-head">
        <span className="cut cut-chip od-state">{STAGE_LABEL[stage]}</span>
        <span className="od-kind">Applied {day(app.createdAt)}</span>
      </header>
      <p className="od-who">
        {app.gameName} <span className="meta">by {app.studio}</span>
      </p>
      <dl className="od-facts">
        <div>
          <dt>Contact</dt>
          <dd>{app.contactEmail}</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd className="tnum">{app.programId}</dd>
        </div>
        {app.site && (
          <div>
            <dt>Website</dt>
            <dd>{app.site}</dd>
          </div>
        )}
        <div>
          <dt>Paid until</dt>
          <dd>{app.paidUntil ? day(app.paidUntil) : "Not paid yet"}</dd>
        </div>
        {standing?.chain && standing.chain.listedUntil > 0 && (
          <div>
            <dt>Listed on chain until</dt>
            <dd>{day(standing.chain.listedUntil)}</dd>
          </div>
        )}
      </dl>
      {app.blurb && <p className="meta">{app.blurb}</p>}
      {app.payments.length > 0 && (
        <p className="meta">Payments: {app.payments.map((p) => `$${p.amountUsd} (${p.kind === "chain" ? "on chain" : "invoice"} ${p.reference})`).join(", ")}</p>
      )}
      {app.status === "applied" && (
        <div className="od-fill">
          <Button variant="money" disabled={busy} onClick={() => onAction?.(app, { kind: "accept" })}>
            Accept
          </Button>
          <Button disabled={busy} onClick={() => onAction?.(app, { kind: "reject" })}>
            Reject
          </Button>
        </div>
      )}
      {app.status === "accepted" && (
        <>
          <Payment app={app} yearUsd={yearUsd} busy={busy} onAction={onAction} />
          <div className="od-fill">
            {(stage === "awaiting-listing" || stage === "needs-reapproval" || stage === "expired") && app.paidUntil && app.paidUntil > now && (
              <Button variant="money" disabled={busy || !standing?.registered} onClick={() => onAction?.(app, { kind: "list" })}>
                {stage === "needs-reapproval" ? "Approve the new version" : "List on chain"}
              </Button>
            )}
            <Button disabled={busy} onClick={() => onAction?.(app, { kind: "feature", on: !app.featured })}>
              {app.featured ? "Stop featuring" : "Feature in the Lobby"}
            </Button>
            {isFeaturedNow(app.featured, stage) && <span className="meta">Showing in the Lobby now.</span>}
          </div>
          {standing && !standing.registered && <p className="meta">The Studio has not registered this program with Tesoro yet (register_game, signed by its upgrade authority).</p>}
        </>
      )}
      {mine && (
        <p className={mine.ok ? "status ok" : "status err"} role={mine.ok ? "status" : "alert"}>
          {mine.text}
        </p>
      )}
    </li>
  );
}

/** Studio applications, payments and listings. Admin wallets only. */
export function ListingView({ reply, standing = {}, error = null, signedOut = false, busy = null, result = null, onAction }: ListingViewProps) {
  return (
    <div className="stack rv od">
      <h1 className="page-title">Studio listings</h1>
      <p className="meta">Studios apply for free. Accept, record the yearly payment (on chain or invoiced), then list the Game on chain until the paid year ends. An upgraded Game stays unlisted until you approve its new version.</p>
      {signedOut && <p role="status">Sign in with an admin wallet to see this page.</p>}
      {error && <p role="alert">{error}</p>}
      {!signedOut && !error && !reply && <p role="status">Loading…</p>}
      {reply &&
        (reply.applications.length === 0 ? (
          <p className="meta">No applications yet.</p>
        ) : (
          <ul className="rv-list">
            {reply.applications.map((a) => (
              <Card key={a.id} app={a} now={reply.now} yearUsd={reply.yearUsd} standing={standing[a.programId]} busy={busy === a.id} result={result} onAction={onAction} />
            ))}
          </ul>
        ))}
    </div>
  );
}
