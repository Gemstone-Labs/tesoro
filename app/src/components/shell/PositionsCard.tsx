"use client";

import Link from "next/link";
import { useId } from "react";
import { Button, ChainChip } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtAsset, fmtGemas, fmtWhen } from "@/lib/format";
import type { Position } from "@/lib/mock";

const SEGMENTS = 10;
const MAX_ROWS = 3;

/** Share of the Advance's projected yield that has repaid the Debt so far (0..1). */
function repaidShare(p: Position): number {
  if (!p.advance || p.advance.projectedYield <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - p.debt / p.advance.projectedYield));
}

/** Nearest Unlock Estimate among Positions that still owe Debt: an absolute time, or a dash when none is known. */
function unlockText(positions: Position[]): string {
  const dated = positions.filter((p) => p.debt > 0 && p.advance?.unlockEstimate).map((p) => p.advance!.unlockEstimate).sort();
  if (dated.length > 0) return fmtWhen(dated[0]).replace(" UTC", "");
  return positions.length > 0 && positions.every((p) => p.debt === 0) ? "Unlocked" : "–";
}

/** The sidebar's "Your Positions" card: real data when signed in, a sign-in prompt when not. */
export function PositionsCard({ onNavigate }: { onNavigate?: () => void }) {
  const { auth, positions, gemas, onChain, loading } = useAccount();
  const signedOut = auth.status === "signed-out";
  const mock = auth.status === "unconfigured";
  const headId = useId();

  return (
    <section className="cut cut-card pos-card" aria-labelledby={headId}>
      <h2 id={headId} className="pos-title">Your Positions</h2>

      {auth.status === "loading" && <p className="pos-note">Reading your Account…</p>}

      {signedOut && (
        <div className="pos-empty">
          <p className="pos-note">Sign in to see your Positions, Debt and the Gemas you can redeem.</p>
          <Button size="sm" block onClick={() => auth.openSignIn()}>Sign in</Button>
        </div>
      )}

      {(onChain || mock) && loading && positions.length === 0 && <p className="pos-note">Reading Positions from Solana devnet…</p>}

      {(onChain || mock) && !(loading && positions.length === 0) && (
        <>
          {positions.length === 0 ? (
            <div className="pos-empty">
              <p className="pos-note">No Positions yet. Lock a stake to play now with its projected yield.</p>
              <Button size="sm" block href="/wallet" onClick={onNavigate}>Open a Position</Button>
            </div>
          ) : (
            <>
              {positions.slice(0, MAX_ROWS).map((p) => {
                const filled = Math.round(repaidShare(p) * SEGMENTS);
                return (
                  <div className="pos-item" key={p.id}>
                    <div className="pos-line">
                      <ChainChip chain={p.chain} />
                      <b className="tnum">{p.principal.toLocaleString("en-US", { maximumFractionDigits: 3 })}</b>
                    </div>
                    <div className="pos-seg" role="img" aria-label={`${Math.round(repaidShare(p) * 100)}% of the Advance repaid by yield`}>
                      {Array.from({ length: SEGMENTS }, (_, i) => (
                        <i key={i} className={i < filled ? "on" : undefined} />
                      ))}
                    </div>
                    <div className="pos-line">
                      <span>Debt</span>
                      <b className="tnum">{p.debt > 0 ? fmtAsset(p.debt, p.asset) : "None"}</b>
                    </div>
                  </div>
                );
              })}
              {positions.length > MAX_ROWS && (
                <Link href="/wallet" className="pos-more" onClick={onNavigate}>
                  +{positions.length - MAX_ROWS} more in Wallet
                </Link>
              )}
              <div className="pos-line pos-est">
                <span>Unlock Estimate</span>
                <b className="tnum">{unlockText(positions)}</b>
              </div>
            </>
          )}
          <div className="cut cut-chip pos-now" style={{ ["--edge" as string]: "rgba(45,190,140,.4)" }}>
            <span>Redeemable now</span>
            <b className="tnum">{fmtGemas(gemas.redeemable)}</b>
          </div>
          <div className="cut cut-chip pos-pend">
            <span>Pending</span>
            <b className="tnum">{fmtGemas(gemas.pending)}</b>
          </div>
          {mock && <p className="pos-note sim">Example data (MOCK)</p>}
        </>
      )}
    </section>
  );
}
