"use client";

import { useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { Button, GemaMark } from "@/components/ui";
import { fmtGemas, fmtGemasUsd } from "@/lib/format";
import type { AdminOrder, OrdersReply } from "@/server/admin/orders";
import "./review.css";
import "./orders.css";

const when = (secs: number) => new Date(secs * 1000).toUTCString().replace(" GMT", " UTC");
/** Whole shares of a 9-decimal token, 4 places. */
const shares = (raw: string) => (Number(BigInt(raw)) / 1e9).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const STATE: Record<AdminOrder["state"], string> = {
  requested: "Waiting for Tesoro",
  "partly-sold": "Partly filled",
  expired: "Expired",
  finished: "Finished",
};

export interface OrdersViewProps {
  /** Null while it loads. */
  reply: OrdersReply | null;
  error?: string | null;
  signedOut?: boolean;
  /** The order being filled right now (its address). */
  busy?: string | null;
  /** Last fill outcome: a signature, or an error line. */
  result?: { address: string; ok: boolean; text: string } | null;
  onFill?: (order: AdminOrder, gemas: bigint) => void;
}

function OrderCard({ o, busy, result, onFill }: { o: AdminOrder; busy: boolean; result: OrdersViewProps["result"]; onFill?: OrdersViewProps["onFill"] }) {
  const [text, setText] = useState(String(o.maxFill));
  const fillable = o.kind !== "reported" && o.state !== "expired" && o.state !== "finished" && o.maxFill > 0;
  const n = Math.floor(Number(text.replace(/,/g, "")));
  const valid = Number.isFinite(n) && n > 0 && n <= o.maxFill;
  const mine = result && result.address === o.address ? result : null;
  return (
    <li className="cut cut-card od-order">
      <header className="od-head">
        <span className="cut cut-chip od-state">{STATE[o.state]}</span>
        <span className="od-kind">{o.asset} · {o.kind === "reported" ? "filled by the bridge" : o.kind === "stake" ? "staking token" : "simSOL"}</span>
      </header>
      <p className="od-who">
        <AccountLink account={o.account} />
        <span className="meta"> offers </span>
        <b className="tnum">{fmtGemas(o.remaining)}</b> <GemaMark size={14} /> <span className="meta">({fmtGemasUsd(o.remaining)})</span>
      </p>
      <dl className="od-facts">
        <div>
          <dt>Asked for</dt>
          <dd className="tnum">{fmtGemas(o.requested)}</dd>
        </div>
        <div>
          <dt>Already sold</dt>
          <dd className="tnum">{fmtGemas(o.sold)}</dd>
        </div>
        <div>
          <dt>Ready (paid in full first)</dt>
          <dd className="tnum">{fmtGemas(o.ready)}</dd>
        </div>
        <div>
          <dt>Most we can buy now</dt>
          <dd className="tnum">{fmtGemas(o.maxFill)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{when(o.expiresAt)}</dd>
        </div>
      </dl>
      {fillable ? (
        <form
          className="od-fill"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onFill?.(o, BigInt(n));
          }}
        >
          <label>
            <span className="meta">Gemas to buy</span>
            <input inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!valid} className="tnum" />
          </label>
          <Button type="button" size="sm" disabled={busy} onClick={() => setText(String(o.maxFill))}>
            {o.maxFill >= o.remaining - o.ready ? "All" : "Max"}
          </Button>
          <Button variant="money" disabled={!valid || busy} type="submit">
            {busy ? "Filling…" : n >= o.remaining - o.ready ? "Fill order" : "Fill part"}
          </Button>
        </form>
      ) : (
        <p className="meta">{o.kind === "reported" ? "Filled by the bridge keeper." : o.maxFill === 0 ? "Nothing to buy now: the route has no spendable shares for it." : "Nothing to fill."}</p>
      )}
      {mine && (
        <p className={mine.ok ? "status ok" : "status err"} role={mine.ok ? "status" : "alert"}>
          {mine.text}
        </p>
      )}
    </li>
  );
}

/** Open Instant Redeem orders and the Treasury's spendable figure. Admin wallets only; the page holds no data until the server answers. */
export function OrdersView({ reply, error = null, signedOut = false, busy = null, result = null, onFill }: OrdersViewProps) {
  return (
    <div className="stack rv od">
      <h1 className="page-title">Instant Redeem orders</h1>
      <p className="meta">Players offer won Gemas that are waiting on yield. Fill all of an order or part of it; Tesoro never pays more than the spendable shares below.</p>
      {signedOut && <p role="status">Sign in with an admin wallet to see this page.</p>}
      {error && <p role="alert">{error}</p>}
      {!signedOut && !error && !reply && <p role="status">Loading…</p>}
      {reply && (
        <>
          <section className="od-budget" aria-label="Spendable">
            <h2>Spendable now</h2>
            <dl className="od-facts">
              <div>
                <dt>simSOL route</dt>
                <dd className="tnum">{reply.routes.native ? `${shares(reply.routes.native.spendable)} shares` : "No Treasury"}</dd>
              </div>
              <div>
                <dt>Staking-token route</dt>
                <dd className="tnum">{reply.routes.stake ? `${shares(reply.routes.stake.spendable)} shares` : "No Treasury"}</dd>
              </div>
            </dl>
            <p className="meta">Open fees, the Pool&apos;s half and the prize escrow are not spendable.</p>
          </section>
          <section className="stack" aria-label="Open orders">
            <h2>
              Open orders <span className="meta">{reply.orders.length}</span>
            </h2>
            {reply.orders.length === 0 ? (
              <p className="meta">No open orders.</p>
            ) : (
              <ul className="rv-list">
                {reply.orders.map((o) => (
                  <OrderCard key={o.address} o={o} busy={busy === o.address} result={result} onFill={onFill} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
