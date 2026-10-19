"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
import { setLimitsOpen } from "@/lib/identity/limits-sheet";

export interface AgeConfirmProps {
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onDecline: () => void;
}

/** Asked once per Account before its first Match entry. Declining cancels the entry; the Entry Limit line never blocks. */
export function AgeConfirm({ busy, error, onConfirm, onDecline }: AgeConfirmProps) {
  return (
    <div className="enter-age" role="group" aria-label="Before your first Match">
      <p className="status">
        Before your first Match, confirm you are 18 or older. This is part of our <Link href="/terms" target="_blank" rel="noreferrer">Terms</Link>.
      </p>
      <p className="meta">
        You can set an Entry Limit on how many Gemas you enter each week.{" "}
        <button type="button" className="enter-age-link" onClick={() => setLimitsOpen(true)}>
          Open Limits
        </button>
      </p>
      {error && <p className="status err" role="alert">{error}</p>}
      <div className="hstack wrap">
        <Button variant="money" onClick={onConfirm} disabled={busy}>I’m 18 or older</Button>
        <Button onClick={onDecline} disabled={busy}>Not now</Button>
      </div>
    </div>
  );
}
