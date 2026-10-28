"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Check, ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { useGuideTip } from "@/components/guide/Guide";
import { Button } from "@/components/ui";
import { GemaMark } from "@/components/ui/gema";
import { ChainGlyph } from "@/components/ui/inputs";
import { useAccount } from "@/lib/account";
import { coreUnitsToWei } from "@/lib/chain/eth-units";
import { fmtEth, lzScanUrl, netOfVault, shortHex } from "@/lib/chain/eth";
import { OPS_EVENT, loadOps, type EthOp } from "@/lib/chain/eth-track";
import { fmtGemas, fmtWhen } from "@/lib/format";
import { useEthCtx, useOpTracker } from "../EthPositions";
import "./opening.css";
import { BRAND } from "@/lib/brand";

const stepsFor = (label: string) => [`${label} confirmed`, "Reached Solana", "Lock recorded", "Gemas available"];
/** Steps of the five-step `open` op that must be done for each of the four shown steps. */
const NEEDS = [1, 2, 3, 5];
const notesFor = (label: string) => [`Your Lock is open on ${label}`, `${BRAND.name} received it on Solana`, "Added to your Account", "Your Advance lands as Gemas"];
const ACTIVE = ["Confirming…", "Delivering…", "Recording…", "Taking your Advance…"];

function useOps(address: string | null): EthOp[] {
  const [ops, setOps] = useState<EthOp[]>([]);
  useEffect(() => {
    if (!address) return;
    const read = () => setOps(loadOps(address));
    const first = setTimeout(read, 0);
    window.addEventListener(OPS_EVENT, read);
    return () => {
      clearTimeout(first);
      window.removeEventListener(OPS_EVENT, read);
    };
  }, [address]);
  return address ? ops : [];
}

export function Opening() {
  const ctx = useEthCtx();
  const address = ctx?.signer.publicKey.toBase58() ?? null;
  const key = useSearchParams().get("op");
  const ops = useOps(address).filter((o) => o.kind === "open");
  const op = ops.find((o) => o.key === key) ?? ops.find((o) => !o.done) ?? ops[0] ?? null;
  return op && ctx && address ? <Tracker op={op} address={address} /> : <Empty signedIn={!!ctx} />;
}

function Empty({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="op">
      <div className="cut cut-frame op-ticket">
        <h1 className="op-empty-title">Locking your coins</h1>
        <p className="op-sub">{signedIn ? "No ETH or HYPE Lock is starting in this browser." : "Sign in to see a Lock that is starting."}</p>
        <div className="op-actions">
          <Button href="/vault">Back to Vault</Button>
        </div>
      </div>
    </div>
  );
}

function useElapsed(since: number, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

function Tracker({ op, address }: { op: EthOp; address: string }) {
  const net = netOfVault(op.vault);
  const STEPS = stepsFor(net.label);
  const NOTES = notesFor(net.label);
  const { refresh } = useAccount();
  const ctx = useEthCtx()!;
  const { stage, note, error, scan, state, finished } = useOpTracker(op, ctx, address, refresh);
  const elapsed = useElapsed(op.createdAt, !finished);
  useGuideTip({ id: "xc-open", pose: "herWaitingCrosschain", title: "Crossing chains", text: "Crossing chains usually takes 2–5 minutes. You can leave this page. Taking your Advance is the last step and needs your signature: it continues when you come back to your Vault." }, !finished);

  const done = STEPS.map((_, i) => finished || stage >= NEEDS[i]);
  const active = done.findIndex((d) => !d);
  const principal = state?.core ? coreUnitsToWei(state.core.principalUnits) : (state?.bridge?.principal ?? null);
  const issued = state?.source?.math.issued ?? null;
  const months = op.months ?? state?.bridge?.horizonMonths ?? null;
  const live = (i: number) => (i === 1 && scan ? scan.name.charAt(0) + scan.name.slice(1).toLowerCase() + "…" : ACTIVE[i]);

  return (
    <div className="op">
      <h1 className="sr-only">{finished ? `Your ${net.native} Lock is open` : `Locking your ${net.native}`}</h1>
      <article className={`cut cut-frame op-ticket${finished ? " is-done" : ""}`}>
        <header className="op-top">
          <span className={`op-status${finished ? " ok" : error ? " bad" : ""}`} role="status">
            {finished ? <Check aria-hidden="true" /> : error ? <TriangleAlert aria-hidden="true" /> : <LoaderCircle className="op-spin" aria-hidden="true" />}
            {finished ? "Lock open" : error ? "Retrying" : `Opening · ${elapsed}`}
          </span>
          <div className="op-swap">
            <div>
              <span className="label">You locked</span>
              <b><ChainGlyph asset={net.native === "ETH" ? 1 : 2} size={30} /> {principal !== null ? fmtEth(principal, 2) : "—"} <small>{net.native}</small></b>
            </div>
            <ArrowRight className="op-arrow" aria-hidden="true" />
            <div>
              <span className="label">You get</span>
              <b className={finished ? "em" : "pending"}>
                <GemaMark size={30} /> {issued !== null ? <>{fmtGemas(Number(issued))} <small>Gemas</small></> : <small>Counting…</small>}
              </b>
            </div>
          </div>
          <p className="op-sub">{finished ? "In your balance now. What you lock stays locked and is never played." : "Gemas arrive once your Lock has crossed to Solana."}</p>
        </header>

        <div className="op-perf" aria-hidden="true" />

        <ol className="op-line" aria-label="Cross-chain progress">
          {STEPS.map((title, i) => {
            const s = done[i] ? "done" : i === active ? (error ? "failed" : "active") : "waiting";
            const now = s === "active" || s === "failed";
            return (
              <li key={title} className={s} aria-current={now ? "step" : undefined}>
                <span className="op-dot">{s === "done" ? <Check aria-hidden="true" /> : s === "active" ? <LoaderCircle className="op-spin" aria-hidden="true" /> : s === "failed" ? <TriangleAlert aria-hidden="true" /> : i + 1}</span>
                <div>
                  <b>{title}</b>
                  <span>{s === "failed" ? `${error?.replace(/\.$/, "")} · retrying` : now ? (note ?? live(i)) : NOTES[i]}</span>
                </div>
                <time>{i === 0 ? clock(op.createdAt) : s === "done" ? "Done" : now ? "Now" : ""}</time>
              </li>
            );
          })}
        </ol>

        <div className="op-perf" aria-hidden="true" />

        <dl className="op-rows">
          <div><dt>Route</dt><dd>{net.label} → Solana</dd></div>
          <div><dt>Length</dt><dd>{months ? `${months} month${months === 1 ? "" : "s"}` : "—"}</dd></div>
          <div><dt>Started</dt><dd>{fmtWhen(op.createdAt)}</dd></div>
          {op.hash && (
            <div>
              <dt>Transaction</dt>
              <dd><a className="mono" href={lzScanUrl(op.hash)} target="_blank" rel="noreferrer">{shortHex(op.hash)} <ExternalLink aria-hidden="true" /></a></dd>
            </div>
          )}
          {finished && <div><dt>Unlock Estimate</dt><dd>In your Vault</dd></div>}
        </dl>
        <div className="op-actions">
          {finished && (
            <Button variant="money" href="/play">
              Play now <ArrowRight aria-hidden="true" />
            </Button>
          )}
          <Button href="/vault">Back to Vault</Button>
          {!finished && op.hash && (
            <a className="btn cut cut-btn neutral" href={lzScanUrl(op.hash)} target="_blank" rel="noreferrer">
              Track the crossing <ExternalLink aria-hidden="true" />
            </a>
          )}
        </div>
      </article>
    </div>
  );
}
