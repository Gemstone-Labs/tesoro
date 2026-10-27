"use client";

import { useState } from "react";
import { Button, Busy, ChainGlyph, CheckIcon, ClockIcon, GemaAmount, GemaMark, Sheet } from "@/components/ui";
import { gemasToAsset } from "@/lib/advance";
import { redeemableOf, useAccount } from "@/lib/account";
import { INSTANT_UNAVAILABLE_TITLE } from "@/lib/chain/fees";
import { DEFAULT_YIELD_FEE_BPS, REDEEM_PAYOUT_PCT } from "@/lib/chain/yield";
import { friendlyError } from "@/lib/chain/native-flow";
import type { ChainPosition } from "@/lib/chain/read";
import { returnOwn, returnRows } from "@/lib/chain/return-own";
import { fmtAsset, fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import type { Chain, Position } from "@/lib/mock";
import { allocate, clampPick, scaled } from "./pick-amount";
import "./money-sheets.css";
import { BRAND } from "@/lib/brand";

const GLYPH: Record<Chain, 0 | 1 | 2> = { SOL: 0, ETH: 1, HYPE: 2 };
const CHAIN_NAME: Record<Chain, string> = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" };
const DIGITS: Record<Chain, number> = { SOL: 5, ETH: 6, HYPE: 4 };
const fmtPayout = (n: number, asset: Chain) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: DIGITS[asset] });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const ArrowDown = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v15m-6-6 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
);

/** One Source's share of a Redeem: `amount` of `token`, or null when it cannot be priced yet. */
export type RedeemPayout = {
  key: string;
  asset: Chain;
  /** "Your SOL Position" or "Won · Ab12…Cd34" */
  from: string;
  gemas: number;
  amount: number | null;
  token: string;
  /** Pays on the Source's own chain a few minutes after the Solana step (ETH and HYPE). */
  later: boolean;
  /** The Yield Fee this line's Gemas pay when cashed out, in bps (0 for fee and prize Gemas). Defaults to the launch rate. */
  yieldFeeBps?: number;
};

/** What a line's Gemas are worth in dollars after its Yield Fee. */
const afterYieldFee = (r: RedeemPayout, gemas = r.gemas) => (gemasToUsd(gemas) * (10_000 - (r.yieldFeeBps ?? DEFAULT_YIELD_FEE_BPS))) / 10_000;

export type RedeemDone = { gemas: number; later: boolean; instant?: boolean; cancelled?: boolean };

/** One holding "Redeem now" would sell, after the treasury's limit: `amount` of `token` is paid now. */
export type InstantRow = RedeemPayout;

/** An Instant Redeem order that is waiting for Tesoro to buy it. */
export type OpenOrderRow = {
  key: string;
  /** Gemas still on offer. */
  gemas: number;
  /** Gemas Tesoro has bought so far. */
  sold: number;
  /** Unix ms. */
  expiresAt: number;
  state: "requested" | "partly-sold" | "expired";
};

/** The Instant Redeem side of the Redeem sheet. */
export type InstantOffer = {
  /** Orders already waiting for Tesoro; the Player can cancel them. */
  orders?: OpenOrderRow[];
  rows: InstantRow[];
  /** What Tesoro keeps for paying now, in percent (taken after the Yield Fee). */
  feePct: number;
  /** The Yield Fee every cash-out pays, in percent. */
  yieldFeePct: number;
  /** The most each asset can be paid right now, null when not read yet. */
  available: { asset: Chain; amount: number | null; token: string }[];
  /** Plain reason Redeem now cannot be used, shown instead of the rows. */
  unavailable: string | null;
  /** Some rows are ETH or HYPE Gemas: Redeem now fetches the latest yield first. */
  fetchesYield?: boolean;
};

/** Redeem as an exchange: every redeemable Gema in, each Source asset out, the Sources folded away. */
export function RedeemExchange({ payouts, instant = null, busy, busyNote, yieldCheck, error, done, canSign, onRedeem, onInstant, onCancelOrder, onClose }: {
  payouts: RedeemPayout[];
  /** Won Gemas can be sold now for less; omitted where that does not apply (offline). */
  instant?: InstantOffer | null;
  busy: boolean;
  /** What the wait is for, when it is more than the payout itself (e.g. fetching the latest yield). */
  busyNote?: string | null;
  /** Won ETH or HYPE Gemas are all still pending, so nothing is redeemable until the latest yield is fetched: names the chains. */
  yieldCheck?: string | null;
  error: string | null;
  done: RedeemDone | null;
  canSign: boolean;
  /** Redeem this many Gemas, split over the lines in the order `payouts` lists them. */
  onRedeem: (gemas: number) => void;
  /** Offer this many pending Gemas, split over the lines in the order `instant.rows` lists them. */
  onInstant?: (gemas: number) => void;
  /** Takes an open order's unsold Gemas back. */
  onCancelOrder?: (key: string) => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(false);
  /** The Gemas the Player typed for each side; null = all of them. */
  const [picks, setPicks] = useState<{ redeem: number | null; now: number | null }>({ redeem: null, now: null });
  if (done) {
    return (
      <div className="mx">
        <div className="status ok" role="status"><CheckIcon /> {done.cancelled ? "Taken back" : done.instant ? "Waiting for Tesoro to buy" : "Redeemed"} {fmtGemas(done.gemas)} Gemas</div>
        {done.instant && <p className="meta">{BRAND.name} buys these when it can, all or part. Gemas it has not bought by the deadline come back to you, and you can take them back any time before.</p>}
        {done.later && <p className="meta">Your ETH and HYPE payouts arrive on their own chain in a few minutes. The Vault shows their progress.</p>}
        <Button block onClick={onClose}>Done</Button>
      </div>
    );
  }
  const yieldPanel = yieldCheck ? (
    <div className="mx-empty">
      <span className="mx-empty-mark"><GemaMark size={34} /></span>
      <b>Waiting on yield</b>
      <p className="meta">Your won {yieldCheck} Gemas become redeemable as their Lock earns yield, and that yield only reaches {BRAND.name} when you ask. Get the latest yield first (usually a minute or two); whatever it covers is redeemed straight after, and if it covers nothing yet you are told.</p>
      {error && <p className="status err" role="alert">{error}</p>}
      {busy ? <Busy>{busyNote ?? "Getting the latest yield…"}</Busy> : <Button variant="money" size="lg" block disabled={!canSign} onClick={() => onRedeem(Number.MAX_SAFE_INTEGER)}>Get the latest yield and redeem</Button>}
    </div>
  ) : null;
  if (payouts.length === 0 && !instant) {
    if (yieldPanel) return <div className="mx">{yieldPanel}</div>;
    return (
      <div className="mx-empty">
        <span className="mx-empty-mark"><GemaMark size={34} /></span>
        <b>Nothing to redeem yet</b>
        <p className="meta">Gemas become redeemable as their Lock earns yield. Check back in a few minutes.</p>
        <Button block onClick={onClose}>Close</Button>
      </div>
    );
  }

  const showInstant = now && instant !== null;
  const available = showInstant ? instant.rows : payouts;
  const max = available.reduce((s, p) => s + p.gemas, 0);
  const side = showInstant ? "now" : "redeem";
  const total = clampPick(picks[side] ?? max, max);
  const parts = allocate(available, total);
  const shown = available.flatMap((p, i) => (parts[i] > 0 ? [{ ...p, gemas: parts[i], amount: scaled(p.amount, p.gemas, parts[i]) }] : []));
  const redeemFeePct = (shown[0]?.yieldFeeBps ?? DEFAULT_YIELD_FEE_BPS) / 100;
  const setPick = (v: number) => setPicks((cur) => ({ ...cur, [side]: clampPick(v, max) }));
  const afterFees = shown.reduce((s, p) => s + afterYieldFee(p), 0) * (showInstant ? (100 - instant.feePct) / 100 : 1);
  const groups = (["SOL", "ETH", "HYPE"] as Chain[])
    .map((asset) => ({ asset, rows: shown.filter((p) => p.asset === asset) }))
    .filter((g) => g.rows.length > 0);
  return (
    <div className="mx">
      {instant && (
        <fieldset className="cut pick-rail money mx-mode" style={{ ["--n" as string]: 2, ["--i" as string]: now ? 1 : 0 }}>
          <legend className="sr-only">When to redeem</legend>
          <span className="pick-thumb" aria-hidden="true" />
          <label>
            <input type="radio" name="mx-when" checked={!now} onChange={() => setNow(false)} />
            <span className="cut">Redeem <small>{REDEEM_PAYOUT_PCT}% of the value, as yield lands</small></span>
          </label>
          <label>
            <input type="radio" name="mx-when" checked={now} onChange={() => setNow(true)} />
            <span className="cut">Redeem now <small>{Math.round(REDEEM_PAYOUT_PCT * (100 - instant.feePct)) / 100}% of the value, when {BRAND.name} buys</small></span>
          </label>
        </fieldset>
      )}
      {showInstant && (instant.unavailable || shown.length === 0) ? (
        <div className="mx-empty">
          <b>{INSTANT_UNAVAILABLE_TITLE}</b>
          <p className="meta">{instant.unavailable ?? "None of your won Gemas are waiting on yield. Redeem them as their yield lands."}</p>
          <Button block onClick={onClose}>Close</Button>
        </div>
      ) : shown.length === 0 && yieldPanel && !showInstant ? (
        yieldPanel
      ) : shown.length === 0 ? (
        <div className="mx-empty">
          <span className="mx-empty-mark"><GemaMark size={34} /></span>
          <b>Nothing to redeem yet</b>
          <p className="meta">Gemas become redeemable as their Lock earns yield. Check back in a few minutes.</p>
          <Button block onClick={onClose}>Close</Button>
        </div>
      ) : (
      <>
      <div className="mx-pair">
        <div className="mx-panel cut">
          <div className="mx-head"><span className="label">You give</span><span className="meta">{fmtGemas(max)} {showInstant ? "still pending" : "redeemable"}</span></div>
          <label className="mx-fig mx-input">
            <GemaMark size={30} glint />
            <input
              inputMode="numeric"
              aria-label={showInstant ? "Gemas to offer" : "Gemas to redeem"}
              value={fmtGemas(total)}
              onChange={(e) => setPick(Number(e.target.value.replace(/\D/g, "")) || 0)}
            />
            <span>Gemas</span>
          </label>
          <div className="mx-quick">
            {[0.25, 0.5, 0.75, 1].map((q) => {
              const v = Math.floor(max * q);
              return (
                <button key={q} type="button" className="cut" aria-pressed={total === v} onClick={() => setPick(v)}>
                  {q === 1 ? "Max" : `${q * 100}%`}
                </button>
              );
            })}
          </div>
        </div>
        <span className="mx-arrow cut" aria-hidden="true"><ArrowDown /></span>
        <div className="mx-panel get cut">
          <div className="mx-head"><span className="label">You get{showInstant ? " when bought" : ""}</span><span className="meta">{showInstant ? `${fmtUsd(afterFees)} after the ${instant.yieldFeePct}% Yield Fee and ${instant.feePct}% fee` : redeemFeePct > 0 ? `${fmtUsd(afterFees)} after the ${redeemFeePct}% Yield Fee` : fmtUsd(afterFees)}</span></div>
          {groups.map(({ asset, rows }) => {
            const priced = rows.every((r) => r.amount !== null);
            const amount = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
            const later = rows.some((r) => r.later);
            return (
              <div key={asset} className="mx-asset">
                <ChainGlyph asset={GLYPH[asset]} size={28} />
                <span className="mx-amt">{priced && <b className="tnum">{fmtPayout(amount, asset)}</b>} {rows[0].token}</span>
                <span className="mx-when">
                  {later ? <><ClockIcon /> paid as sim{asset} on {CHAIN_NAME[asset]}, in a few minutes</> : <>to your wallet, now</>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {showInstant && (
        <p className="mx-fee">
          Only Gemas still waiting on yield are offered, yours or won. You are paid after the {instant.yieldFeePct}% Yield Fee, and {BRAND.name} keeps another {instant.feePct}% for paying you now and collects the yield later. Gemas whose yield has landed are redeemed normally as soon as you ask. This is a request: you are paid when {BRAND.name} buys it.
        </p>
      )}
      <details className="mx-from">
        <summary>From {plural(shown.length, "Lock")}</summary>
        <dl className="kv">
          {shown.map((p) => (
            <div key={p.key} style={{ display: "contents" }}>
              <dt className="hstack"><ChainGlyph asset={GLYPH[p.asset]} size={14} /> {p.from}</dt>
              <dd>{fmtGemas(p.gemas)} → {p.amount !== null ? `${fmtPayout(p.amount, p.asset)} ` : ""}{p.token}</dd>
            </div>
          ))}
        </dl>
      </details>
      {showInstant && (
        <details className="mx-from">
          <summary>Most {BRAND.name} can pay right now</summary>
          <dl className="kv">
            {instant.available.map((a) => (
              <div key={a.asset} style={{ display: "contents" }}>
                <dt className="hstack"><ChainGlyph asset={GLYPH[a.asset]} size={14} /> {a.token}</dt>
                <dd>{a.amount !== null ? `up to ${fmtPayout(a.amount, a.asset)}` : "not read yet"}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {instant && (instant.orders?.length ?? 0) > 0 && (
        <div className="mx-orders">
          <span className="label">Waiting for {BRAND.name}</span>
          {instant.orders!.map((o) => (
            <div key={o.key} className="hstack" style={{ justifyContent: "space-between" }}>
              <span className="meta">
                {fmtGemas(o.gemas)} Gemas · {o.state === "expired" ? "past its deadline" : o.sold > 0 ? `${fmtGemas(o.sold)} bought so far` : "requested"}
              </span>
              <Button size="sm" disabled={busy || !canSign || !onCancelOrder} onClick={() => onCancelOrder?.(o.key)}>{o.state === "expired" ? "Take back" : "Cancel"}</Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="status err" role="alert">{error}</p>}
      {busy ? (
        <Busy>{busyNote ?? "Paying out your Gemas…"}</Busy>
      ) : (
        <Button variant="money" size="lg" block disabled={!canSign || total <= 0} onClick={() => (showInstant ? onInstant?.(total) : onRedeem(total))}>
          {showInstant ? "Offer for sale" : "Redeem"} <GemaAmount value={total} size="md" />
        </Button>
      )}
      </>
      )}
    </div>
  );
}

/** One Advance the Gemas can go back to. */
export type ReturnChoice = { key: string; label: string; max: number; debt: number };

/**
 * Return as an exchange: Gemas in (typed, or a quarter of what you hold), the Debt they cancel out. `toDebt` turns
 * Gemas into the Debt's unit and `fmtDebt` writes it (Gemas on chain, the Source asset offline).
 */
export function ReturnExchange({
  choices, pick, onPick, value, onChange, toDebt = (g) => g, fmtDebt = (n) => `${fmtGemas(n)} Gemas`, busy, error, done, canSign, onReturn, onClose,
}: {
  choices: ReturnChoice[];
  pick: number;
  onPick: (i: number) => void;
  value: number;
  onChange: (gemas: number) => void;
  toDebt?: (gemas: number) => number;
  fmtDebt?: (n: number) => string;
  busy: boolean;
  error: string | null;
  done: { gemas: number; cleared: boolean } | null;
  canSign: boolean;
  onReturn: () => void;
  onClose: () => void;
}) {
  if (done) {
    return (
      <div className="mx">
        <div className="status ok" role="status">
          <CheckIcon /> Returned {fmtGemas(done.gemas)} Gemas · {done.cleared ? "Paid back, your Lock unlocks" : "Left to pay back is lower"}
        </div>
        <Button block onClick={onClose}>Done</Button>
      </div>
    );
  }
  const c = choices[pick];
  if (!c) {
    return (
      <div className="mx-empty">
        <span className="mx-empty-mark"><GemaMark size={34} /></span>
        <b>No Gemas to return</b>
        <p className="meta">Only your own unspent Gemas from this Lock can go back. Won Gemas and Gemas held for Offers stay with you.</p>
        <Button block onClick={onClose}>Close</Button>
      </div>
    );
  }

  const after = Math.max(0, c.debt - toDebt(value));
  return (
    <div className="mx">
      {choices.length > 1 && (
        <div className="mx-seg" role="radiogroup" aria-label="Advance to return to">
          {choices.map((ch, i) => (
            <button key={ch.key} type="button" role="radio" aria-checked={i === pick} className="cut" onClick={() => onPick(i)}>
              {ch.label} <small>{fmtDebt(ch.debt)} left to pay back</small>
            </button>
          ))}
        </div>
      )}
      <div className="mx-pair">
        <div className="mx-panel cut">
          <div className="mx-head"><span className="label">You give</span><span className="meta">{fmtGemas(c.max)} unspent</span></div>
          <label className="mx-fig mx-input">
            <GemaMark size={30} glint />
            <input
              inputMode="numeric"
              aria-label="Gemas to return"
              value={fmtGemas(value)}
              onChange={(e) => onChange(Math.min(c.max, Number(e.target.value.replace(/\D/g, "")) || 0))}
            />
            <span>Gemas</span>
          </label>
          <div className="mx-quick">
            {[0.25, 0.5, 0.75, 1].map((q) => {
              const v = Math.floor(c.max * q);
              return (
                <button key={q} type="button" className="cut" aria-pressed={value === v} onClick={() => onChange(v)}>
                  {q === 1 ? "Max" : `${q * 100}%`}
                </button>
              );
            })}
          </div>
        </div>
        <span className="mx-arrow cut" aria-hidden="true"><ArrowDown /></span>
        <div className="mx-panel get cut">
          <div className="mx-head"><span className="label">Left to pay back</span><span className="meta">now {fmtDebt(c.debt)}</span></div>
          <div className="mx-fig"><b className={after === 0 ? "clear" : undefined}>{fmtDebt(after)}</b></div>
          <span className="mx-when">{after === 0 ? <><CheckIcon /> Paid back: your Lock unlocks</> : "Your Lock stays locked until it is paid back"}</span>
        </div>
      </div>
      {error && <p className="status err" role="alert">{error}</p>}
      {busy ? (
        <Busy>Returning your Gemas…</Busy>
      ) : (
        <Button variant="money" size="lg" block disabled={!canSign || value === 0} onClick={onReturn}>
          Return <GemaAmount value={value} size="md" />
        </Button>
      )}
    </div>
  );
}

/* ——— offline (no sign-in configured): simulated ——— */

export function RedeemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { holdings } = useAccount();
  const [done, setDone] = useState<RedeemDone | null>(null);
  const payouts: RedeemPayout[] = holdings
    .filter((h) => redeemableOf(h) > 0)
    .map((h) => ({
      key: h.source.positionId,
      asset: h.source.chain,
      from: h.own ? `Your ${h.source.asset} Lock` : `Won · ${h.source.owner}`,
      gemas: redeemableOf(h),
      amount: (gemasToAsset(redeemableOf(h), h.source.asset) * REDEEM_PAYOUT_PCT) / 100,
      token: h.source.chain === "SOL" ? "test SOL" : h.source.asset,
      later: h.source.chain !== "SOL",
    }));
  const total = payouts.reduce((s, p) => s + p.gemas, 0);
  return (
    <Sheet open={open} onClose={() => { setDone(null); onClose(); }} title="Redeem">
      <RedeemExchange
        payouts={payouts}
        busy={false}
        error={null}
        done={done}
        canSign
        onRedeem={(gemas) => setDone({ gemas: Math.min(gemas, total), later: payouts.some((p) => p.later) })}
        onClose={() => { setDone(null); onClose(); }}
      />
    </Sheet>
  );
}

export function ReturnSheet({ position, onClose }: { position: Position | null; onClose: () => void }) {
  return (
    <Sheet open={position !== null} onClose={onClose} title="Return unspent Gemas">
      {position && <ReturnForm key={position.id} position={position} onClose={onClose} />}
    </Sheet>
  );
}

function ReturnForm({ position, onClose }: { position: Position; onClose: () => void }) {
  const { holdings } = useAccount();
  const held = holdings.find((h) => h.own && h.source.positionId === position.id)?.gemas ?? 0;
  const [amount, setAmount] = useState(Math.min(held, 1000));
  const [done, setDone] = useState<{ gemas: number; cleared: boolean } | null>(null);
  const toDebt = (g: number) => gemasToAsset(g, position.asset);
  return (
    <ReturnExchange
      choices={held > 0 ? [{ key: position.id, label: "Advance", max: held, debt: position.debt }] : []}
      pick={0}
      onPick={() => {}}
      value={amount}
      onChange={setAmount}
      toDebt={toDebt}
      fmtDebt={(n) => fmtAsset(n, position.asset)}
      busy={false}
      error={null}
      done={done}
      canSign
      onReturn={() => setDone({ gemas: amount, cleared: toDebt(amount) >= position.debt })}
      onClose={onClose}
    />
  );
}

/* ——— on chain ——— */

/** The Gemas this Account can return to `position`'s Sources, 0 when none. */
export function useReturnable(position: ChainPosition): bigint {
  const { snapshot } = useAccount();
  if (!snapshot) return 0n;
  return returnRows(snapshot.holdings, position.address, snapshot.accountKey).reduce((s, r) => s + r.max, 0n);
}

/** `return_own` on a live Position: the owner's own-Sourced, unspent Gemas cancel that much Debt, per Source. */
export function ReturnOwnSheet({ position, open, onClose, onReturned }: { position: ChainPosition; open: boolean; onClose: () => void; onReturned?: () => Promise<void> | void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Return unspent Gemas">
      {open && <ReturnOwnForm position={position} onClose={onClose} onReturned={onReturned} />}
    </Sheet>
  );
}

function ReturnOwnForm({ position, onClose, onReturned }: { position: ChainPosition; onClose: () => void; onReturned?: () => Promise<void> | void }) {
  const { auth, snapshot, refresh } = useAccount();
  const rows = snapshot ? returnRows(snapshot.holdings, position.address, snapshot.accountKey) : [];
  const [pick, setPick] = useState(0);
  const at = Math.min(pick, Math.max(0, rows.length - 1));
  const row = rows[at] ?? null;
  const [amount, setAmount] = useState(() => Number(row?.max ?? 0n));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ gemas: number; cleared: boolean } | null>(null);
  const value = Math.min(amount, Number(row?.max ?? 0n));

  const submit = async () => {
    if (!row || !auth.signer || value <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await returnOwn(auth.signer, auth.getAccessToken, row.holding, BigInt(value));
      setDone({ gemas: value, cleared: value >= Number(row.holding.sourceDebt) });
      await Promise.all([refresh(), onReturned?.()]);
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReturnExchange
      choices={rows.map((r, i) => ({ key: r.holding.source.toBase58(), label: `Advance ${i + 1}`, max: Number(r.max), debt: Number(r.holding.sourceDebt) }))}
      pick={at}
      onPick={(i) => { setPick(i); setAmount(Number(rows[i].max)); }}
      value={value}
      onChange={setAmount}
      busy={busy}
      error={error}
      done={done}
      canSign={Boolean(auth.signer)}
      onReturn={() => void submit()}
      onClose={onClose}
    />
  );
}
