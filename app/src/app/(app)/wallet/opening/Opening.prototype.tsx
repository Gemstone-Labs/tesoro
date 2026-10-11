"use client";

/**
 * PROTOTYPE ONLY: four takes on the Opening page (/wallet/opening), switched with ?variant=now|A|B|C|D or the pink
 * bar. A Crossing poster, B Receipt, C Gema forming, D Split dashboard. The winner gets rewritten into Opening.tsx on
 * main; this file never lands there.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock, ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { Button, SimulatedYieldLabel } from "@/components/ui";
import { GemaMark } from "@/components/ui/gema";
import { ChainGlyph } from "@/components/ui/inputs";
import { art } from "@/lib/art";
import "./opening.prototype.css";

export interface OpeningModel {
  native: "ETH" | "HYPE";
  netLabel: string;
  noun: string;
  steps: string[];
  subs: string[];
  done: boolean[];
  active: number;
  finished: boolean;
  error: string | null;
  note: string | null;
  principal: string | null;
  advance: string | null;
  months: number | null;
  createdAt: number;
  hash: string | null;
  scanUrl: string | null;
}

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Crossing poster" },
  { key: "B", name: "Receipt" },
  { key: "C", name: "Gema forming" },
  { key: "D", name: "Split dashboard" },
] as const;

export function OpeningPrototype({ model, children }: { model: OpeningModel; children: React.ReactNode }) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && children}
      {v === "A" && <VariantA m={model} />}
      {v === "B" && <VariantB m={model} />}
      {v === "C" && <VariantC m={model} />}
      {v === "D" && <VariantD m={model} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/* ——— shared bits ——— */

const asset = (n: "ETH" | "HYPE") => (n === "ETH" ? 1 : 2);
const stageOf = (m: OpeningModel) => (m.finished ? m.steps.length : m.done.filter(Boolean).length);
const stateOf = (m: OpeningModel, i: number) => (m.done[i] ? "done" : i === m.active ? (m.error ? "failed" : "active") : "waiting");
const NOTES = (net: string) => [`Your Position is open on ${net}`, "Tesoro received it on Solana", "Added to your Account", "Your Advance lands as Gemas"];

function useElapsed(since: number, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

function Mark({ state, i }: { state: string; i: number }) {
  if (state === "done") return <Check aria-hidden="true" />;
  if (state === "active") return <LoaderCircle className="op-spin" aria-hidden="true" />;
  if (state === "failed") return <TriangleAlert aria-hidden="true" />;
  return <>{i + 1}</>;
}

function Actions({ m, playFirst = true }: { m: OpeningModel; playFirst?: boolean }) {
  return (
    <div className="opx-actions">
      {m.finished && playFirst && (
        <Button variant="money" href="/lobby">
          Play now <ArrowRight aria-hidden="true" />
        </Button>
      )}
      <Link className="btn cut cut-btn neutral" href="/wallet">Back to Wallet</Link>
      {m.scanUrl && !m.finished && (
        <a className="btn cut cut-btn neutral" href={m.scanUrl} target="_blank" rel="noreferrer">
          Track the crossing <ExternalLink aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/* ——— A · Crossing poster: one big stage, the two chains facing each other, a packet on the track ——— */

function VariantA({ m }: { m: OpeningModel }) {
  const elapsed = useElapsed(m.createdAt, !m.finished);
  const stage = stageOf(m);
  const legs = m.steps.length - 1;
  const filled = Math.max(0, stage - 1) / legs;
  const packet = m.active <= 0 ? 0 : (m.active - 0.5) / legs;
  const word = m.finished ? "Open" : m.error ? "Retrying" : "Crossing";
  const line = m.finished ? `${m.advance ?? "Your"} Gemas are in your balance.` : m.error ? m.error : m.note ?? m.subs[m.active];
  return (
    <div className={`opa${m.finished ? " is-done" : m.error ? " is-failed" : ""}`}>
      <section className="cut cut-frame opa-stage" aria-label="Cross-chain progress">
        <div className="opa-head">
          <span className="opa-kicker">{m.noun} · {m.netLabel} → Solana</span>
          {!m.finished && <span className="opa-time"><Clock aria-hidden="true" /> {elapsed} · usually 2–5 min</span>}
        </div>
        <h1 className="opa-word">{word}</h1>
        <p className="opa-line" role="status">{line}</p>

        <div className="opa-route">
          <div className={`opa-end cut cut-card ${stateOf(m, 0)}`}>
            <span className="opa-end-mark"><ChainGlyph asset={asset(m.native)} size={56} /></span>
            <b>{m.principal ? `${m.principal} ${m.native}` : m.native}</b>
            <span>Locked on {m.netLabel}</span>
          </div>
          <div className="opa-track" aria-hidden="true">
            <i className="opa-rail" />
            <i className="opa-fill" style={{ width: `${filled * 100}%`, "--h": `${filled * 100}%` } as React.CSSProperties} />
            {m.steps.slice(1, -1).map((t, k) => (
              <span key={t} className={`opa-stop-at ${stateOf(m, k + 1)}`} style={{ left: `${((k + 1) / legs) * 100}%`, "--p": `${((k + 1) / legs) * 100}%` } as React.CSSProperties}>
                <span className="opa-stop cut" />
                <em>{t}</em>
              </span>
            ))}
            {!m.finished && <span className={`opa-packet${m.error ? " failed" : ""}`} style={{ left: `${packet * 100}%`, "--p": `${packet * 100}%` } as React.CSSProperties} />}
          </div>
          <div className={`opa-end cut cut-card dest ${m.finished ? "available" : stateOf(m, legs)}`}>
            <span className="opa-end-mark"><GemaMark size={56} /></span>
            <b>{m.advance ? `${m.advance} Gemas` : "Gemas"}</b>
            <span>{m.finished ? "In your balance" : "Your Account"}</span>
          </div>
        </div>
        <ol className="sr-only">
          {m.steps.map((t, i) => <li key={t} aria-current={i === m.active ? "step" : undefined}>{t}: {m.subs[i]}</li>)}
        </ol>
      </section>

      <div className="opa-tiles">
        <div className="cut cut-card opa-tile">
          <span className="label">Principal</span>
          <b>{m.principal ? `${m.principal} ${m.native}` : "—"}</b>
          <span>Stays yours. Never played.</span>
        </div>
        <div className="cut cut-card opa-tile">
          <span className="label">Advance</span>
          <b className={m.finished ? "em" : ""}>{m.advance ? `${m.advance} Gemas` : "Counting…"}</b>
          <span>{m.months ? `For a ${m.months}-month Horizon` : "For your Horizon"}</span>
        </div>
        <div className="cut cut-card opa-tile">
          <span className="label">{m.finished ? "Next" : "You can leave"}</span>
          <b>{m.finished ? "Play a Match" : "It keeps going"}</b>
          <span>{m.finished ? "Unlock Estimate is in your Wallet" : "The Advance is taken when you're back"}</span>
        </div>
      </div>
      <SimulatedYieldLabel />
      <Actions m={m} />
    </div>
  );
}

/* ——— B · Receipt: a narrow ticket, the conversion on top, a timeline, then the details ——— */

function VariantB({ m }: { m: OpeningModel }) {
  const elapsed = useElapsed(m.createdAt, !m.finished);
  return (
    <div className="opb">
      <article className={`cut cut-frame opb-ticket${m.finished ? " is-done" : ""}`}>
        <header className="opb-top">
          <span className={`opb-status${m.finished ? " ok" : m.error ? " bad" : ""}`}>
            {m.finished ? <Check aria-hidden="true" /> : m.error ? <TriangleAlert aria-hidden="true" /> : <LoaderCircle className="op-spin" aria-hidden="true" />}
            {m.finished ? "Position open" : m.error ? "Retrying" : `Opening · ${elapsed}`}
          </span>
          <div className="opb-swap">
            <div>
              <span className="label">You locked</span>
              <b><ChainGlyph asset={asset(m.native)} size={30} /> {m.principal ?? "—"} <small>{m.native}</small></b>
            </div>
            <ArrowRight className="opb-arrow" aria-hidden="true" />
            <div>
              <span className="label">You get</span>
              <b className={m.finished ? "em" : "pending"}><GemaMark size={30} /> {m.advance ?? <small>Counting…</small>} {m.advance && <small>Gemas</small>}</b>
            </div>
          </div>
          <p className="opb-sub">{m.finished ? "In your balance now. Your Principal stays locked and is never played." : "Gemas arrive once your Position has crossed to Solana."}</p>
        </header>

        <div className="opb-perf" aria-hidden="true" />

        <ol className="opb-line">
          {m.steps.map((t, i) => {
            const s = stateOf(m, i);
            return (
              <li key={t} className={s} aria-current={s === "active" ? "step" : undefined}>
                <span className="opb-dot"><Mark state={s} i={i} /></span>
                <div>
                  <b>{t}</b>
                  <span>{s === "active" || s === "failed" ? (m.error ?? m.note ?? m.subs[i]) : NOTES(m.netLabel)[i]}</span>
                </div>
                <time>{i === 0 ? clock(m.createdAt) : s === "done" ? "Done" : s === "active" ? "Now" : ""}</time>
              </li>
            );
          })}
        </ol>

        <div className="opb-perf" aria-hidden="true" />

        <dl className="opb-rows">
          <div><dt>Route</dt><dd>{m.netLabel} → Solana</dd></div>
          <div><dt>Horizon</dt><dd>{m.months ? `${m.months} months` : "—"}</dd></div>
          <div><dt>Started</dt><dd>{clock(m.createdAt)}</dd></div>
          {m.hash && (
            <div>
              <dt>Transaction</dt>
              <dd>{m.scanUrl ? <a href={m.scanUrl} target="_blank" rel="noreferrer" className="mono">{short(m.hash)} <ExternalLink aria-hidden="true" /></a> : <span className="mono">{short(m.hash)}</span>}</dd>
            </div>
          )}
        </dl>
        <SimulatedYieldLabel />
        <Actions m={m} />
      </article>
    </div>
  );
}

/* ——— C · Gema forming: the Gema's own octagon fills a quarter per step; the character waits beside it ——— */

// the Gema mark's outline (viewBox 24) scaled ×10, cut in four quarters of two edges each, starting top-left
const OCT = [[70, 30], [170, 30], [220, 80], [220, 160], [170, 210], [70, 210], [20, 160], [20, 80]];
const quarter = (q: number) => [0, 1, 2].map((k) => OCT[(q * 2 + k) % 8]).map(([x, y], k) => `${k ? "L" : "M"}${x} ${y}`).join(" ");

function VariantC({ m }: { m: OpeningModel }) {
  const elapsed = useElapsed(m.createdAt, !m.finished);
  const stage = stageOf(m);
  const step = Math.min(m.active < 0 ? m.steps.length - 1 : m.active, m.steps.length - 1);
  return (
    <div className={`opc${m.finished ? " is-done" : m.error ? " is-failed" : ""}`}>
      <section className="cut cut-frame opc-stage" aria-label="Cross-chain progress">
        <div className="opc-copy">
          <span className="opc-kicker">{m.noun}</span>
          <h1 className="opc-title">{m.finished ? "Your Gemas are here" : "Cutting your Gemas"}</h1>
          <p className="opc-line" role="status">
            {m.finished ? "Your Position is open. Its Advance is in your balance, ready to play." : m.error ? `${m.error} · retrying` : `Step ${step + 1} of ${m.steps.length} · ${m.subs[step]}`}
          </p>
          {m.finished ? (
            <div className="opc-figure"><GemaMark size={40} /> <b>+{m.advance ?? "—"}</b> <span>Gemas</span></div>
          ) : (
            <div className="opc-facts">
              <span><ChainGlyph asset={asset(m.native)} size={18} /> {m.principal ? `${m.principal} ${m.native} locked` : `${m.native} locked`}</span>
              <span><Clock aria-hidden="true" /> {elapsed} · usually 2–5 min</span>
            </div>
          )}
          <Actions m={m} />
        </div>

        <div className="opc-dial" aria-hidden="true">
          <svg viewBox="0 0 240 240">
            {[0, 1, 2, 3].map((q) => (
              <path key={q} className={`opc-q ${m.finished || q < stage ? "done" : q === m.active ? (m.error ? "failed" : "active") : "waiting"}`} d={quarter(q)} />
            ))}
          </svg>
          <span className="opc-gem"><GemaMark size={112} glint={m.finished} /></span>
          <ol className="opc-steps">
            {m.steps.map((t, i) => <li key={t} className={stateOf(m, i)}>{t}</li>)}
          </ol>
        </div>

        {!m.finished && <img className="opc-her" src={art.busts.herWaitingCrosschain.src} alt="" width={art.busts.herWaitingCrosschain.w} height={art.busts.herWaitingCrosschain.h} />}
      </section>
      <SimulatedYieldLabel />
    </div>
  );
}

/* ——— D · Split dashboard: the steps as a lit rail on the left, what you get on the right ——— */

function VariantD({ m }: { m: OpeningModel }) {
  const elapsed = useElapsed(m.createdAt, !m.finished);
  const stage = stageOf(m);
  return (
    <div className="opd">
      <header className="opd-head">
        <div>
          <h1 className="page-title">{m.finished ? `Your ${m.noun} is open` : `Opening your ${m.noun}`}</h1>
          <p className="page-sub">{m.finished ? "Your Gemas are available." : "Crossing from " + m.netLabel + " to Solana. Usually 2–5 minutes."}</p>
        </div>
        <span className={`opd-pill${m.finished ? " ok" : ""}`}>
          {m.finished ? <Check aria-hidden="true" /> : <Clock aria-hidden="true" />}
          {m.finished ? "Done" : elapsed}
        </span>
      </header>

      <div className="opd-grid">
        <section className="cut cut-frame opd-rail" aria-label="Cross-chain progress" style={{ "--fill": `${(Math.max(0, stage - 0.5) / m.steps.length) * 100}%` } as React.CSSProperties}>
          <ol>
            {m.steps.map((t, i) => {
              const s = m.finished ? "done" : stateOf(m, i);
              return (
                <li key={t} className={`opd-step ${s}`} aria-current={s === "active" ? "step" : undefined}>
                  <span className="opd-mark cut"><Mark state={s} i={i} /></span>
                  <div className={s === "active" || s === "failed" ? "cut cut-card opd-live" : "opd-body"}>
                    <b>{t}</b>
                    <span>{s === "active" || s === "failed" ? (m.error ? `${m.error} · retrying` : m.note ?? m.subs[i]) : s === "done" ? NOTES(m.netLabel)[i] : "Waiting"}</span>
                    {s === "active" && i <= 1 && m.scanUrl && (
                      <a href={m.scanUrl} target="_blank" rel="noreferrer">Follow it on LayerZero Scan <ExternalLink aria-hidden="true" /></a>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="opd-side">
          <section className="cut cut-frame opd-get" aria-label="What you get">
            <span className="label">What you get</span>
            <div className={`opd-gemas${m.finished ? " ok" : ""}`}>
              <GemaMark size={34} />
              <b>{m.advance ?? "Counting…"}</b>
              <span>{m.finished ? "Gemas · available" : "Gemas · pending"}</span>
            </div>
            <dl>
              <div><dt>Principal locked</dt><dd><ChainGlyph asset={asset(m.native)} size={16} /> {m.principal ? `${m.principal} ${m.native}` : "—"}</dd></div>
              <div><dt>Horizon</dt><dd>{m.months ? `${m.months} months` : "—"}</dd></div>
              <div><dt>Unlock Estimate</dt><dd>{m.finished ? "In your Wallet" : "After opening"}</dd></div>
            </dl>
            <SimulatedYieldLabel />
            {m.finished && (
              <Button variant="money" href="/lobby" block>
                Play now <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </section>
          {!m.finished && (
            <div className="cut cut-card opd-leave">
              <img src={art.busts.herWaitingCrosschain.src} alt="" width={art.busts.herWaitingCrosschain.w} height={art.busts.herWaitingCrosschain.h} />
              <div>
                <b>You can leave this page</b>
                <p>It keeps crossing. Taking your Advance needs your signature: it continues when you open your Wallet.</p>
                <Link href="/wallet">Back to Wallet <ArrowRight aria-hidden="true" /></Link>
              </div>
            </div>
          )}
          {m.finished && <Link className="btn cut cut-btn neutral" href="/wallet">Back to Wallet</Link>}
        </aside>
      </div>
    </div>
  );
}
