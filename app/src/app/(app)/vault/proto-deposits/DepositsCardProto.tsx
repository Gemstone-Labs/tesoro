"use client";

// PROTOTYPE: four takes on the Vault's Deposits card, switched by ?card=a|b|c|d|today. Throwaway: the winner gets
// rewritten into SimpleVault.tsx and the rest moves to a proto/ branch.
import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { packArt } from "@/components/deposit/DepositPanel";
import { Button, CheckIcon, GemaMark } from "@/components/ui";
import { DEPOSIT_PACKS, PACK_MONTHS, type DepositPackId } from "@/lib/deposit/packs";
import { fmtBackAt, type DepositRow } from "@/lib/deposit/vault";
import { fmtGemas, fmtUsd } from "@/lib/format";
import "./proto-deposits.css";

export const CARD_VARIANTS = [
  { key: "a", name: "Pack shelf" },
  { key: "b", name: "Countdown hero" },
  { key: "c", name: "Timeline" },
  { key: "d", name: "Tickets" },
  { key: "today", name: "Today (no info lines)" },
];

export interface ProtoProps {
  deposits: DepositRow[];
  busyId: string | null;
  canWithdraw: boolean;
  onWithdraw: (d: DepositRow) => void;
  /** Withdrawn count + other chains notes, same as today. */
  extras: ReactNode;
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The pack whose price is nearest what the deposit is worth today. */
const packOf = (d: DepositRow): DepositPackId => {
  if (d.worthUsd === null) return "player";
  return DEPOSIT_PACKS.reduce((best, p) => (Math.abs(p.usd - d.worthUsd!) < Math.abs(best.usd - d.worthUsd!) ? p : best)).id;
};
const progress = (d: DepositRow, now: number) => {
  if (d.state !== "growing" || !d.backAtMs) return 1;
  const span = d.backAtMs - d.openedAtMs;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (now - d.openedAtMs) / span));
};
const left = (d: DepositRow, now: number) => (d.backAtMs ? Math.max(0, d.backAtMs - now) : 0);
const two = (n: number) => String(n).padStart(2, "0");
/** "47m 12s", "3h 05m", "12 days", "4 months". */
function fmtLeft(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  if (d >= 60) return `${Math.round(d / 30.4)} months`;
  if (d >= 2) return `${d} days`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${two(m)}m` : `${m}m ${two(s % 60)}s`;
}
/** "00:47:12" for the big clock; days when it is far. */
function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s >= 2 * 86_400) return fmtLeft(ms);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
const worth = (d: DepositRow) => (d.worthUsd === null ? "—" : fmtUsd(Math.round(d.worthUsd)));
const total = (ds: DepositRow[]) => ds.reduce((t, d) => t + (d.worthUsd ?? 0), 0);
const sorted = (ds: DepositRow[]) =>
  [...ds].sort((a, b) => (a.state === "ready" ? -1 : 0) - (b.state === "ready" ? -1 : 0) || (a.backAtMs ?? 0) - (b.backAtMs ?? 0));

function WithdrawBtn({ d, p, block, label }: { d: DepositRow; p: ProtoProps; block?: boolean; label?: string }) {
  return (
    <Button variant="money" size="lg" block={block} disabled={!p.canWithdraw || p.busyId !== null} onClick={() => p.onWithdraw(d)}>
      {p.busyId === `withdraw:${d.id}` ? "Withdrawing…" : (label ?? `Withdraw ${worth(d)}`)}
    </Button>
  );
}
function When({ d, now }: { d: DepositRow; now: number }) {
  if (d.state === "ready") return <span className="pd-ok"><CheckIcon aria-hidden="true" /> Ready to withdraw</span>;
  if (d.state === "late") return <span className="pd-warn">Taking a little longer{d.backAtMs ? ` · about ${fmtBackAt(d.backAtMs)}` : ""}</span>;
  return d.backAtMs ? <span>Back in <b className="pd-mono">{fmtLeft(left(d, now))}</b></span> : <span>Back after about {PACK_MONTHS} months</span>;
}
function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className={`pd-bar ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${value * 100}%` }} />
    </div>
  );
}
function Head({ deposits }: { deposits: DepositRow[] }) {
  return (
    <header className="pd-head">
      <h2 className="display">Deposits</h2>
      {deposits.length > 0 && (
        <p className="pd-total">
          <b>{fmtUsd(Math.round(total(deposits)))}</b> in your Vault
        </p>
      )}
    </header>
  );
}

/* ——— A: Pack shelf. Each deposit is a tall card with its pack art, value, a fill bar and a live countdown. ——— */
export function VariantA(p: ProtoProps) {
  const now = useNow();
  return (
    <section className="cut cut-card vt-deposits pd-a" aria-label="Your deposits">
      <Head deposits={p.deposits} />
      {p.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
      <div className="pd-a-grid">
        {sorted(p.deposits).map((d) => (
          <article key={d.id} className={`cut cut-card pd-a-card ${d.state}`}>
            <span className="pd-a-tag">{d.state === "ready" ? "Ready" : d.state === "late" ? "Running late" : "Coming back"}</span>
            <Image className="pd-a-art" src={packArt(packOf(d))} width={512} height={512} alt="" sizes="200px" />
            <h3>{d.label}</h3>
            <p className="pd-a-worth">{worth(d)}<small>worth today</small></p>
            {d.gemasGiven !== null && (
              <p className="pd-a-gave"><GemaMark size={16} /> Gave you {fmtGemas(d.gemasGiven)} Gemas</p>
            )}
            <Bar value={progress(d, now)} tone={d.state} />
            <p className="pd-a-when"><When d={d} now={now} /></p>
            {d.state === "ready" && <WithdrawBtn d={d} p={p} block />}
          </article>
        ))}
      </div>
      {p.extras}
    </section>
  );
}

/* ——— B: Countdown hero. One big clock for the next deposit home, ready ones as a banner, the rest as slim rows. ——— */
export function VariantB(p: ProtoProps) {
  const now = useNow();
  const ready = p.deposits.filter((d) => d.state === "ready");
  const waiting = sorted(p.deposits.filter((d) => d.state !== "ready"));
  const next = waiting.find((d) => d.state === "growing" && d.backAtMs);
  return (
    <section className="cut cut-card vt-deposits pd-b" aria-label="Your deposits">
      <h2 className="display">Deposits</h2>
      {p.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
      {ready.map((d) => (
        <div key={d.id} className="cut cut-card pd-b-ready">
          <Image className="pd-b-ready-art" src={packArt(packOf(d))} width={512} height={512} alt="" sizes="96px" />
          <div>
            <p className="pd-b-kicker"><CheckIcon aria-hidden="true" /> {d.label} is back</p>
            <p className="pd-b-ready-fig">{worth(d)} <span>ready to withdraw</span></p>
          </div>
          <WithdrawBtn d={d} p={p} label="Withdraw" />
        </div>
      ))}
      {next && (
        <div className="pd-b-hero">
          <div>
            <p className="pd-b-kicker">Next deposit back</p>
            <p className="pd-b-clock pd-mono">{clock(left(next, now))}</p>
            <p className="pd-b-sub">{next.label} · {worth(next)} · around {fmtBackAt(next.backAtMs!)}</p>
          </div>
          <div className="pd-b-sum">
            <p><b>{fmtUsd(Math.round(total(p.deposits)))}</b><span>in your Vault</span></p>
            <p><b>{p.deposits.length}</b><span>{p.deposits.length === 1 ? "deposit" : "deposits"}</span></p>
          </div>
        </div>
      )}
      {waiting.length > 0 && (
        <ul className="pd-b-list">
          {waiting.map((d) => (
            <li key={d.id}>
              <Image src={packArt(packOf(d))} width={512} height={512} alt="" sizes="48px" />
              <div className="pd-b-row">
                <p><b>{d.label}</b><span>{worth(d)}</span><span className="pd-b-when"><When d={d} now={now} /></span></p>
                <Bar value={progress(d, now)} tone={d.state} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {p.extras}
    </section>
  );
}

/* ——— C: Timeline. One track from now to the last deposit home; ready ones wait in a dock at "Now". ——— */
export function VariantC(p: ProtoProps) {
  const now = useNow();
  const ready = p.deposits.filter((d) => d.state === "ready");
  const coming = sorted(p.deposits.filter((d) => d.state !== "ready"));
  const end = Math.max(now + 60_000, ...coming.map((d) => d.backAtMs ?? now));
  const pos = (d: DepositRow) => (d.backAtMs ? Math.min(1, Math.max(0, (d.backAtMs - now) / (end - now))) : 1);
  return (
    <section className="cut cut-card vt-deposits pd-c" aria-label="Your deposits">
      <Head deposits={p.deposits} />
      {p.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
      {p.deposits.length > 0 && (
        <div className="pd-c-wrap">
          <div className={`pd-c-dock${ready.length ? " on" : ""}`}>
            <p className="pd-c-now">Now</p>
            {ready.length === 0 && <p className="pd-c-empty">Nothing ready yet</p>}
            {ready.map((d) => (
              <div key={d.id} className="pd-c-ready">
                <Image src={packArt(packOf(d))} width={512} height={512} alt="" sizes="88px" />
                <p><b>{d.label}</b> {worth(d)}</p>
                <WithdrawBtn d={d} p={p} label="Withdraw" />
              </div>
            ))}
          </div>
          <div className="pd-c-track" aria-label="Coming back" style={{ "--n": coming.length } as React.CSSProperties}>
            <span className="pd-c-line" aria-hidden="true" />
            <span className="pd-c-tick start" aria-hidden="true" />
            {coming.map((d, i) => (
              <div key={d.id} className={`pd-c-pin ${d.state}`} style={{ "--pos": pos(d), "--i": i } as React.CSSProperties}>
                <p className="pd-c-label"><b>{d.label}</b><span>{worth(d)}</span></p>
                <Image src={packArt(packOf(d))} width={512} height={512} alt="" sizes="72px" />
                <span className="pd-c-dot" aria-hidden="true" />
                <p className="pd-c-time">
                  <span>{d.state === "late" ? "Taking longer" : d.backAtMs ? <>in <b className="pd-mono">{fmtLeft(left(d, now))}</b></> : `~${PACK_MONTHS} months`}</span>
                  {d.backAtMs && <small>{fmtBackAt(d.backAtMs)}</small>}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      {p.extras}
    </section>
  );
}

/* ——— D: Tickets. Each deposit is a stub with its number and art, then a three-step trip: In, Playing, Back. ——— */
export function VariantD(p: ProtoProps) {
  const now = useNow();
  return (
    <section className="cut cut-card vt-deposits pd-d" aria-label="Your deposits">
      <Head deposits={p.deposits} />
      {p.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
      <div className="pd-d-list">
        {sorted(p.deposits).map((d) => {
          const v = progress(d, now);
          const steps = [
            { k: "in", label: "Deposited", sub: fmtBackAt(d.openedAtMs), done: true },
            { k: "play", label: d.gemasGiven !== null ? `${fmtGemas(d.gemasGiven)} Gemas` : "Gemas", sub: "yours to play", done: true },
            { k: "back", label: d.state === "ready" ? "Back" : "Comes back", sub: d.state === "ready" ? "ready now" : d.backAtMs ? fmtBackAt(d.backAtMs) : `~${PACK_MONTHS} months`, done: d.state === "ready" },
          ];
          const num = d.label.replace(/\D+/g, "");
          return (
            <article key={d.id} className={`pd-d-ticket ${d.state}`}>
              <div className="pd-d-stub">
                <span className="pd-d-no">No. {two(Number(num) || 0)}</span>
                <Image src={packArt(packOf(d))} width={512} height={512} alt="" sizes="120px" />
                <b className="pd-d-worth">{worth(d)}</b>
                <span className="pd-d-worth-sub">worth today</span>
              </div>
              <div className="pd-d-body">
                <div className="pd-d-top">
                  <h3>{d.label}</h3>
                  <p><When d={d} now={now} /></p>
                </div>
                <ol className="pd-d-steps" style={{ "--v": v } as React.CSSProperties}>
                  {steps.map((s) => (
                    <li key={s.k} className={s.done ? "done" : ""}>
                      <span className="pd-d-dot" aria-hidden="true">{s.done ? <CheckIcon /> : null}</span>
                      <b>{s.label}</b>
                      <small>{s.sub}</small>
                    </li>
                  ))}
                </ol>
                {d.state === "ready" && <div className="pd-d-act"><WithdrawBtn d={d} p={p} /></div>}
              </div>
            </article>
          );
        })}
      </div>
      {p.extras}
    </section>
  );
}
