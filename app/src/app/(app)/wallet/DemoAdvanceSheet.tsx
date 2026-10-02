"use client";

import { useState } from "react";
import { Button, CheckIcon, Chip, GemaAmount, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { ensureReady } from "@/lib/chain/match-flow";
import { takeDemoAdvance } from "@/lib/chain/demo-client";
import { fmtUsd, gemasToUsd } from "@/lib/format";

const STEPS = ["Topping up devnet SOL for fees", "Creating your Account on Solana", "Opening a simulated Position", "Signing the Advance"];

/**
 * Simulated · demo Advance. Stopgap until Solana-native Position custody exists: the server opens a
 * SIMULATED Position for this Account and the Account signs the real `take_advance`.
 * See app/docs/demo-funding.md.
 */
export function DemoAdvanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { auth, refresh } = useAccount();
  const [step, setStep] = useState<number | null>(null);
  const [result, setResult] = useState<{ gemas: number; signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signer = auth.signer;

  const take = async () => {
    if (!signer) return;
    setError(null);
    setStep(0);
    try {
      await ensureReady(signer, auth.getAccessToken);
      setStep(2);
      const r = await takeDemoAdvance(signer, auth.getAccessToken);
      setResult(r);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setStep(null);
    }
  };

  const close = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title="Get Gemas">
      <Chip tone="warn">Simulated · demo Advance</Chip>
      <p className="meta">
        Position custody on Solana is not built yet, so Tesoro opens a <strong>simulated</strong> 10 SOL Position for your
        Account (10% APY, 6-month Horizon, SOL at $150) and issues its Advance. The Gemas are real devnet Gemas with a
        simulated Source. Limited per Account.
      </p>
      <dl className="kv">
        <dt>Gemas issued</dt>
        <dd><GemaAmount value={7500} size="lg" /></dd>
        <dt>Worth at issuance</dt>
        <dd>{fmtUsd(gemasToUsd(7500))}</dd>
        <dt>Redeemable now</dt>
        <dd>20% (simulated yield already accrued)</dd>
      </dl>
      {result ? (
        <>
          <div className="status ok" role="status">
            <CheckIcon /> <GemaAmount value={result.gemas} size="md" /> issued
          </div>
          <a className="meta mono" href={`https://explorer.solana.com/tx/${result.signature}?cluster=devnet`} target="_blank" rel="noreferrer">
            take_advance · {result.signature.slice(0, 10)}…
          </a>
          <Button block onClick={close}>Done</Button>
        </>
      ) : (
        <>
          {step !== null && <p className="status" role="status">{STEPS[Math.min(step, STEPS.length - 1)]}…</p>}
          {error && <p className="status err" role="alert">{error}</p>}
          <Button variant="money" block disabled={!signer || step !== null} onClick={take}>
            {step !== null ? "Working…" : "Take demo Advance · 7,500 Gemas"}
          </Button>
        </>
      )}
    </Sheet>
  );
}
