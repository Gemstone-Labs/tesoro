"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Label } from "@/components/ui";
import { Slider } from "@/components/ui/inputs";
import { FILL, RULES, SIDE, type Asset } from "./chain";
import { Chart } from "./Chart";
import { isStale, midToUsd, type PriceFeed } from "./feed";
import { chips, clock, describeFill, relativeLead, sideName, signedChips, tPlus, usdMid } from "./fmt";
import { START_CHIPS, close, equity, liquidationMid, openProblem, previewOpen, type Ledger, type Lead } from "./math";
import "./trading.css";

export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

export interface ScreenProps {
  asset: Asset;
  /** Heading; defaults to "Trading Duel". */
  title?: string;
  /** Gema entry of this Match, shown as the money chip. */
  entry?: number;
  practice?: boolean;
  feed: PriceFeed;
  /** Your Book; null while it is being read. */
  ledger: Ledger | null;
  seat: 0 | 1;
  /** The coarse public lead and the opponent's trade count; null before it is known. */
  opponent: { lead: Lead; trades: number } | null;
  /** Trading opens / closes, ms. */
  startsAt: number;
  endsAt: number;
  /** Length of the window in seconds (the progress bar); defaults to the Match's 300. */
  durationSecs?: number;
  /** The window is over: no orders. */
  ended?: boolean;
  busy: string | null;
  error?: string | null;
  onOpen: (side: 1 | 2, margin: bigint, leverage: number) => void;
  onClose: () => void;
  onFlip: (side: 1 | 2, margin: bigint, leverage: number) => void;
  /** Extra panel under the header (a practice banner, a final-price note). */
  banner?: ReactNode;
}

const PRESETS: { label: string; share: number }[] = [
  { label: "25%", share: 0.25 },
  { label: "50%", share: 0.5 },
  { label: "75%", share: 0.75 },
  { label: "Max", share: 1 },
];

/**
 * The Trading Duel screen for one Player. Desktop: the chart on the left, the order and position
 * panels on the right. Phones stack them. Direction is sapphire (up, long) and amber (down,
 * short), always with a word or symbol too; emerald never appears (Chips are not Gemas).
 */
export function TradingScreen(p: ScreenProps) {
  const { asset, feed, ledger, seat, opponent, ended } = p;
  const now = useNow();
  const mid = feed.tick?.mid ?? null;
  const stale = isStale(feed.tick, now);
  const countdown = Math.ceil((p.startsAt - now) / 1000);
  const remaining = Math.ceil((p.endsAt - now) / 1000);
  const phase: "countdown" | "live" | "ended" = ended || remaining <= 0 ? "ended" : countdown > 0 ? "countdown" : "live";

  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);

  const eq = ledger && mid ? equity(ledger, mid) : null;
  const pnl = eq !== null ? eq - START_CHIPS : null;
  const holding = !!ledger && ledger.side !== SIDE.flat;
  const posValue = ledger && mid && holding ? eq! - ledger.cash : 0n;
  const unrealised = holding && ledger ? posValue - ledger.margin : 0n;
  const liq = ledger ? liquidationMid(ledger) : null;

  // Chips you can put to work: what is free, or (when flipping) what closing the position frees.
  const available = useMemo(() => {
    if (!ledger) return 0n;
    if (holding && mid) {
      try {
        return close(ledger, mid, 0).ledger.cash;
      } catch {
        return ledger.cash;
      }
    }
    return ledger.cash;
  }, [ledger, holding, mid]);
  const maxSize = Number(available);
  const minSize = RULES.minMargin;
  const sizeNow = Math.min(Math.max(size, minSize), Math.max(maxSize, minSize));
  const margin = BigInt(sizeNow);
  const problem = ledger ? openProblem({ ...ledger, cash: available }, margin, leverage) : "not-enough-chips";

  const tradable = phase === "live" && !stale && !!mid && !p.busy && !!ledger;
  const reason = !ledger
    ? "Loading your trades…"
    : phase === "countdown"
      ? `Trading opens in ${Math.max(0, countdown)} s`
      : phase === "ended"
        ? "Time’s up"
        : stale || !mid
          ? "Waiting for a fresh price"
          : p.busy
            ? "Sending…"
            : null;

  const preview = (side: 1 | 2) => (mid ? previewOpen(side, margin, leverage, mid) : null);
  const pv = preview(SIDE.long);
  const pvShort = preview(SIDE.short);

  const orderDisabled = !tradable || problem !== null;
  const why = reason ?? (problem === "margin-too-small" ? `Size is at least ${RULES.minMargin} Chips` : problem === "not-enough-chips" ? "Not enough free Chips" : null);

  const rel = opponent ? relativeLead(opponent.lead, seat) : null;
  const dur = p.durationSecs ?? RULES.durationSecs;
  const pct = phase === "ended" ? 100 : Math.min(100, Math.max(0, ((dur - remaining) / dur) * 100));
  const windowFrom = p.startsAt - 25_000;
  const fills = ledger?.fills ?? [];

  return (
    <section className="td" aria-label="Trading Duel">
      <header className="td-head">
        <div className="td-head-l">
          <h1 className="td-title">{p.title ?? "Trading Duel"}</h1>
          <span className="cut cut-chip td-asset">{asset.symbol}/USD</span>
          {p.entry !== undefined && (
            <span className="cut cut-btn td-entry">{chips(p.entry)} Gemas entry</span>
          )}
          {p.practice && <span className="cut cut-chip td-asset">Practice</span>}
        </div>
        <div className="td-clock" role="timer" aria-live="off">
          <div className="td-clock-top">
            <span className="td-clock-l">{phase === "countdown" ? "Starts in" : phase === "ended" ? "Window" : "Time left"}</span>
            <span className={`mono td-secs${phase === "live" && remaining <= 30 ? " low" : ""}`}>
              {phase === "countdown" ? `${Math.max(0, countdown)} s` : phase === "ended" ? "Closed" : clock(remaining)}
            </span>
          </div>
          <div className="td-bar" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      {p.banner}

      <div className="td-grid2">
        <div className="td-main">
          <div className="cut cut-card td-card td-ticker">
            <div className="td-px">
              <Label>{asset.symbol} live price</Label>
              <b className="mono td-price">{mid ? usdMid(mid, asset) : "…"}</b>
              <span className={`td-feed ${stale ? "stale" : "live"}`}>{feed.status === "waiting" ? "Connecting" : stale ? "Feed delayed" : "Live"}</span>
            </div>
            <div className="td-eq">
              <div>
                <Label>Your equity</Label>
                <b className="mono td-big">{eq !== null ? chips(eq) : "…"}</b>
              </div>
              <div>
                <Label>PnL</Label>
                <b className="mono td-big">{pnl !== null ? signedChips(pnl) : "…"}</b>
              </div>
              <div>
                <Label>Opponent</Label>
                <b className="td-lead" aria-live="polite">{rel ?? "…"}</b>
                <span className="meta">{opponent ? `${opponent.trades} ${opponent.trades === 1 ? "trade" : "trades"}` : ""}</span>
              </div>
            </div>
          </div>

          <div className="cut cut-card td-card td-chartcard">
            <Chart
              asset={asset}
              series={feed.series}
              from={windowFrom}
              to={p.endsAt}
              startsAt={p.startsAt}
              fills={fills}
              origin={p.startsAt}
              entry={holding && ledger ? { price: Number(ledger.entry) / 1e8, side: ledger.side } : null}
              liquidation={liq ? midToUsd(liq) : null}
              now={now}
            />
          </div>

          <div className="cut cut-card td-card">
            <Label>Your trades</Label>
            {fills.length === 0 ? (
              <p className="meta td-empty">No trades yet. Fills execute at the live price plus a {RULES.spreadBps / 100}% spread.</p>
            ) : (
              <ol className="td-log" aria-label="Your fills, newest first">
                {[...fills].reverse().map((f, i) => (
                  <li key={fills.length - i}>
                    <span className="mono td-t">{tPlus(f.t)}</span>
                    <span className={`td-dir ${f.side === SIDE.long ? "up" : "down"}`} aria-hidden="true">{f.side === SIDE.long ? "▲" : "▼"}</span>
                    <span className="td-what">{describeFill(f, asset)}</span>
                    {f.kind !== FILL.open && <span className="mono td-pnl">{signedChips(f.pnl)}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <aside className="td-side" aria-label="Orders">
          {holding && ledger && (
            <div className={`cut cut-card td-card td-pos ${ledger.side === SIDE.long ? "up" : "down"}`}>
              <div className="td-pos-head">
                <span className="td-badge">
                  <span aria-hidden="true">{ledger.side === SIDE.long ? "▲" : "▼"}</span> {sideName(ledger.side)} {ledger.leverage}x
                </span>
                <b className="mono td-big">{signedChips(unrealised)}</b>
              </div>
              <dl className="td-kv">
                <dt>Size</dt>
                <dd className="mono">{chips(ledger.margin)} Chips</dd>
                <dt>Notional</dt>
                <dd className="mono">{chips(ledger.notional)}</dd>
                <dt>Entry</dt>
                <dd className="mono">{usdMid(ledger.entry, asset)}</dd>
                <dt>Mark</dt>
                <dd className="mono">{mid ? usdMid(mid, asset) : "…"}</dd>
                <dt>Liquidation</dt>
                <dd className="mono">{liq ? usdMid(liq, asset) : "none"}</dd>
              </dl>
            </div>
          )}

          <div className="cut cut-card td-card td-order">
            <div className="td-order-head">
              <Label>{holding ? "Close or flip" : "New position"}</Label>
              <span className="meta mono">Free {chips(ledger?.cash ?? 0n)} Chips</span>
            </div>
            <div className="td-sl">
              <Slider
                label="Size"
                value={sizeNow}
                min={minSize}
                max={Math.max(maxSize, minSize + 1)}
                step={1}
                onChange={setSize}
                display={<span className="mono">{chips(sizeNow)} Chips</span>}
                minLabel={String(minSize)}
                maxLabel={chips(maxSize)}
              />
            </div>
            <div className="td-presets">
              {PRESETS.map((pr) => (
                <button
                  key={pr.label}
                  type="button"
                  className="cut cut-chip td-preset"
                  disabled={maxSize < minSize}
                  onClick={() => setSize(Math.max(minSize, pr.share === 1 ? maxSize : Math.floor((maxSize * pr.share) / 10) * 10))}
                >
                  {pr.label}
                </button>
              ))}
            </div>
            <div className="td-sl">
              <Slider label="Leverage" value={leverage} min={RULES.minLeverage} max={RULES.maxLeverage} step={1} onChange={setLeverage} display={<span className="mono">{leverage}x</span>} minLabel="1x" maxLabel="20x" />
            </div>
            <p className="meta td-preview">
              Notional <b className="mono">{chips(margin * BigInt(leverage))}</b>
              {pv?.liquidation && pvShort?.liquidation && (
                <>
                  {" "}· liquidation near <span className="mono">{usdMid(pv.liquidation, asset)}</span> long, <span className="mono">{usdMid(pvShort.liquidation, asset)}</span> short
                </>
              )}
            </p>

            {!holding ? (
              <div className="td-btns">
                <button type="button" className="cut cut-btn td-btn up" disabled={orderDisabled} onClick={() => p.onOpen(SIDE.long, margin, leverage)}>
                  <span aria-hidden="true">{"▲"}</span> Long
                </button>
                <button type="button" className="cut cut-btn td-btn down" disabled={orderDisabled} onClick={() => p.onOpen(SIDE.short, margin, leverage)}>
                  <span aria-hidden="true">{"▼"}</span> Short
                </button>
              </div>
            ) : (
              <div className="td-btns">
                <button type="button" className="cut cut-btn td-btn neutral" disabled={!tradable} onClick={() => p.onClose()}>
                  Close
                </button>
                <button
                  type="button"
                  className={`cut cut-btn td-btn ${ledger!.side === SIDE.long ? "down" : "up"}`}
                  disabled={orderDisabled}
                  onClick={() => p.onFlip(ledger!.side === SIDE.long ? SIDE.short : SIDE.long, margin, leverage)}
                >
                  <span aria-hidden="true">{ledger!.side === SIDE.long ? "▼" : "▲"}</span> Flip to {ledger!.side === SIDE.long ? "Short" : "Long"}
                </button>
              </div>
            )}
            {why && <p className="meta td-why" role="status">{why}</p>}
            {p.busy && <p className="meta td-why" role="status">{p.busy}…</p>}
            {p.error && <p className="status err" role="alert">{p.error}</p>}
          </div>

          <div className="cut cut-card td-card td-rules">
            <Label>The rules</Label>
            <ul className="td-ul">
              <li>One position at a time, 1x to 20x.</li>
              <li>Fills use the live price with a {RULES.spreadBps / 100}% spread. If the price feed pauses for more than {RULES.maxStaleSecs} s, trading waits for a fresh price.</li>
              <li>Liquidated near {RULES.maintenanceBps / 100}% of notional left, at the next price read.</li>
              <li>Open positions close at the final price; higher equity wins, equal equity is a draw.</li>
              <li>Your positions stay hidden from your opponent until the Match ends.</li>
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
