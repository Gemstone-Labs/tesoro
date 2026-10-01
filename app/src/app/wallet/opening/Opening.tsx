"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock, LoaderCircle } from "lucide-react";
import { useGuideTip } from "@/components/guide/Guide";
import { Button, ChainChip, SimulatedYieldLabel } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtEth, lzScanUrl } from "@/lib/chain/eth";
import { OPS_EVENT, loadOps, type EthOp } from "@/lib/chain/eth-track";
import { fmtGemas } from "@/lib/format";
import { useEthCtx, useOpTracker } from "../EthPositions";
import "./opening.css";

const STEPS = ["Hoodi confirmed", "LayerZero delivered", "Position recorded", "Gemas available"];
/** Steps of the five-step `open` op that must be done for each of the four shown steps. */
const NEEDS = [1, 2, 3, 5];
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
      <h1 className="page-title">Opening your ETH Position</h1>
      <p className="page-sub">{signedIn ? "No ETH Position is opening in this browser." : "Sign in to see an ETH Position that is opening."}</p>
      <div className="op-actions">
        <Button href="/wallet">Back to Wallet</Button>
      </div>
    </div>
  );
}

function Tracker({ op, address }: { op: EthOp; address: string }) {
  const { refresh } = useAccount();
  const ctx = useEthCtx()!;
  const { stage, note, error, scan, state, finished } = useOpTracker(op, ctx, address, refresh);
  useGuideTip({ id: "xc-open", bust: "herWaitingCrosschain", title: "Crossing chains", text: "LayerZero usually takes 2–5 minutes. You can leave this page. Taking your Advance is the last step and needs your signature: it continues when you come back to your Wallet." }, !finished);

  const done = STEPS.map((_, i) => finished || stage >= NEEDS[i]);
  const active = done.findIndex((d) => !d);
  const core = state?.core ?? null;
  const issued = state?.source?.math.issued ?? null;
  const scanKey = op.hash;

  return (
    <div className="op">
      <header className="page-head">
        <div>
          <h1 className="page-title">{finished ? "Your ETH Position is open" : "Opening your ETH Position"}</h1>
          <p className="page-sub">{finished ? "Your Gemas are available." : "Your Position is crossing chains. Gemas become available after confirmation."}</p>
        </div>
      </header>

      <section className="cut cut-frame op-track" aria-label="Cross-chain progress">
        <span className={`cut cut-card op-status${finished ? " ok" : ""}`}>
          {finished ? <Check aria-hidden="true" /> : <LoaderCircle className="op-spin" aria-hidden="true" />}
          {finished ? "GEMAS AVAILABLE" : error ? "RETRYING" : "IN PROGRESS"}
        </span>
        <ol className="op-steps">
          {STEPS.map((title, i) => {
            const state = done[i] ? "done" : i === active ? "active" : "waiting";
            const sub = state === "done" ? (i === STEPS.length - 1 ? "Available" : "Confirmed") : state === "active" ? (i === 1 && scan ? scan.name.charAt(0) + scan.name.slice(1).toLowerCase() + "…" : ACTIVE[i]) : "Waiting";
            return (
              <li key={title} className={`cut cut-card op-step ${state}`} aria-current={state === "active" ? "step" : undefined}>
                <span className="op-mark" aria-hidden="true">
                  {state === "done" ? <Check /> : state === "active" ? <LoaderCircle className="op-spin" /> : i + 1}
                </span>
                <b>{title}</b>
                <span>{sub}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="cut cut-frame op-summary" aria-labelledby="op-sum">
        <h2 id="op-sum" className="sr-only">Position summary</h2>
        <p className="op-line">
          <ChainChip chain="ETH" />
          <span>{core ? `${fmtEth(core.principalWei)} ETH Position` : "Position amount pending"}</span>
          <span>{issued !== null ? `${fmtGemas(Number(issued))} Gemas Advance` : "Advance pending"}</span>
          {finished && <span>Unlock Estimate in your Wallet</span>}
        </p>
        <SimulatedYieldLabel />
        <div className={`cut cut-card op-note${finished ? " ok" : ""}`} role="status">
          <span className="op-note-icon" aria-hidden="true">{finished ? <Check /> : <Clock />}</span>
          <div>
            <b>{finished ? "Gemas are available." : "Gemas are not available yet."}</b>
            <p>
              {finished
                ? "They are in your balance and ready to play. Your Principal stays locked and is never played."
                : note ?? "Your Position is crossing chains. Stay here or go to your Wallet: your Advance is taken while one of them is open."}
            </p>
            {error && !finished && <p className="op-err" role="alert">{error} · retrying</p>}
          </div>
        </div>
        <div className="op-actions">
          <Link className="btn cut cut-btn neutral" href="/wallet">Back to Wallet</Link>
          {scanKey ? (
            <a className="btn cut cut-btn neutral" href={lzScanUrl(scanKey)} target="_blank" rel="noreferrer">
              View progress <ArrowRight aria-hidden="true" />
            </a>
          ) : (
            <Button href="/wallet">
              View progress <ArrowRight aria-hidden="true" />
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
