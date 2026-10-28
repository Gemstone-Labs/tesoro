"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getChain } from "@/lib/chain/client";
import { unlockIxs } from "@/lib/chain/redeem";
import { previewUnlockShortfall, shortfallCopy, shortfallLamports, unlockFeePayer } from "@/lib/chain/unlock-shortfall";
import { sponsorStatus } from "@/lib/chain/sponsor-client";
import type { NativeInfo } from "@/lib/chain/native";
import { PublicKey } from "@solana/web3.js";

/** The shortfall notice: before Unlock (`after` false) and on the receipt after. Renders nothing when the Lock returns in full. */
export function UnlockShortfallNote({ gapLamports, principalLamports, symbol, after = false }: { gapLamports: bigint | null; principalLamports: bigint; symbol: string; after?: boolean }) {
  const copy = gapLamports ? shortfallCopy({ gapLamports, principalLamports, symbol, after }) : null;
  if (!copy) return null;
  return (
    <div className="wl-short" role="status">
      <b>{copy.title}</b>
      <span>{copy.body}</span>
    </div>
  );
}

/**
 * What this Unlock would return less than the Locked amount at today's rate, read by dry-running the Unlock (the program's own
 * `UnlockShortfall`), not computed here. Null while unknown or when it pays in full.
 */
export function useUnlockShortfall(info: NativeInfo, payer: PublicKey | undefined, rate: bigint | undefined, enabled: boolean): bigint | null {
  const [gap, setGap] = useState<bigint | null>(null);
  const real = info.stakeRateOpen > 0n;
  const latest = useRef(info);
  useEffect(() => {
    latest.current = info;
  });
  useEffect(() => {
    if (!enabled || !real || !payer || !rate) return;
    let live = true;
    (async () => {
      try {
        const ixs = await unlockIxs(payer, latest.current);
        const relayer = new PublicKey((await sponsorStatus()).relayer);
        const found = await previewUnlockShortfall(getChain().base, unlockFeePayer(ixs, payer, relayer), ixs);
        if (live) setGap(found.state === "short" ? shortfallLamports(found.shortfall.gapShares, rate) : null);
      } catch (e) {
        console.warn("Unlock dry run could not run", e);
        if (live) setGap(null);
      }
    })();
    return () => {
      live = false;
    };
    // The same Position at the same rate gives the same answer: re-read only when either changes.
  }, [enabled, real, payer, rate, info.position, info.custodyShares, info.openAdvance]);
  return gap;
}

const KEY = (position: PublicKey) => `tesoro.unlock-short.${position.toBase58()}`;

/** The shortfall an Unlock reported, kept in this browser so the receipt survives a reload. */
export function saveUnlockReceipt(position: PublicKey, gapLamports: bigint) {
  try {
    localStorage.setItem(KEY(position), gapLamports.toString());
  } catch {}
}

function readReceipt(position: PublicKey): string | null {
  try {
    return localStorage.getItem(KEY(position));
  } catch {
    return null;
  }
}

/** The saved receipt of an unlocked Position, or `override` (stories). Null on the server and when none was kept. */
export function useUnlockReceipt(position: PublicKey, override?: bigint | null): bigint | null {
  const saved = useSyncExternalStore(
    () => () => {},
    () => readReceipt(position),
    () => null,
  );
  if (override !== undefined) return override;
  return saved ? BigInt(saved) : null;
}
