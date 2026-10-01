"use client";

import { useState } from "react";
import { Button, CheckIcon, ChainChip, GemaAmount, Sheet, Slider } from "@/components/ui";
import { gemasToAsset } from "@/lib/advance";
import { redeemableOf, useAccount } from "@/lib/account";
import { friendlyError } from "@/lib/chain/native-flow";
import type { ChainPosition } from "@/lib/chain/read";
import { returnOwn, returnRows } from "@/lib/chain/return-own";
import { fmtAsset, fmtGemas } from "@/lib/format";
import type { Position } from "@/lib/mock";

export function RedeemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { holdings, gemas } = useAccount();
  const [done, setDone] = useState(false);
  const rows = holdings.filter((h) => redeemableOf(h) > 0);
  return (
    <Sheet open={open} onClose={() => { setDone(false); onClose(); }} title="Redeem">
      <p className="meta">
        Each Gema redeems for its Source asset, only as far as that Source Position&apos;s yield has actually accrued.
        Winning Gemas never shorten your own lock.
      </p>
      <dl className="kv">
        {rows.map((h) => (
          <div key={h.source.positionId} style={{ display: "contents" }}>
            <dt className="hstack"><ChainChip chain={h.source.chain} /> {h.source.owner}</dt>
            <dd>
              {fmtGemas(redeemableOf(h))} → {fmtAsset(gemasToAsset(redeemableOf(h), h.source.asset), h.source.asset)}
            </dd>
          </div>
        ))}
      </dl>
      {done ? (
        <div className="status ok" role="status">
          <CheckIcon /> Redeemed {fmtGemas(gemas.redeemable)} Gemas (simulated)
        </div>
      ) : (
        <Button variant="money" block onClick={() => setDone(true)}>
          Redeem {fmtGemas(gemas.redeemable)}
        </Button>
      )}
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
  const [done, setDone] = useState(false);
  const reduces = gemasToAsset(amount, position.asset);
  const newDebt = Math.max(0, position.debt - reduces);

  if (held === 0) {
    return (
      <>
        <p className="meta">You hold no Gemas Sourced from this Position.</p>
        <Button block onClick={onClose}>Close</Button>
      </>
    );
  }

  return (
    <>
      <p className="meta">
        Returning Gemas Sourced from your {position.asset} Position reduces its Debt. The Position stays locked until
        Debt reaches zero.
      </p>
      <Slider
        label="Gemas to return"
        value={amount}
        min={0}
        max={held}
        step={50}
        onChange={setAmount}
        display={<GemaAmount value={amount} size="md" />}
        minLabel="0"
        maxLabel={fmtGemas(held)}
      />
      <dl className="kv">
        <dt>Debt now</dt>
        <dd>{fmtAsset(position.debt, position.asset)}</dd>
        <dt>Debt after</dt>
        <dd>{fmtAsset(newDebt, position.asset)}</dd>
      </dl>
      {done ? (
        <div className="status ok" role="status">
          <CheckIcon /> Returned {fmtGemas(amount)} Gemas (simulated)
        </div>
      ) : (
        <Button variant="money" block disabled={amount === 0} onClick={() => setDone(true)}>
          Return {fmtGemas(amount)} Gemas
        </Button>
      )}
    </>
  );
}

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
  const row = rows[Math.min(pick, rows.length - 1)] ?? null;
  const [amount, setAmount] = useState(() => Number(row?.max ?? 0n));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ sig: string; amount: number } | null>(null);

  if (done) {
    return (
      <>
        <div className="status ok" role="status">
          <CheckIcon /> Returned {fmtGemas(done.amount)} Gemas · Debt lowered
        </div>
        <a className="meta mono" href={`https://explorer.solana.com/tx/${done.sig}?cluster=devnet`} target="_blank" rel="noreferrer">
          return_own · {done.sig.slice(0, 10)}…
        </a>
        <Button block onClick={onClose}>Done</Button>
      </>
    );
  }

  if (!row) {
    return (
      <>
        <p className="meta">You hold no unspent Gemas Sourced from this Position. Won Gemas and Gemas reserved for Offers cannot be returned.</p>
        <Button block onClick={onClose}>Close</Button>
      </>
    );
  }

  const max = Number(row.max);
  const value = Math.min(amount, max);
  const debt = Number(row.holding.sourceDebt);
  const submit = async () => {
    if (!auth.signer || value <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const sig = await returnOwn(auth.signer, position.address, row.holding.source, BigInt(value));
      setDone({ sig, amount: value });
      await Promise.all([refresh(), onReturned?.()]);
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="meta">
        Returning Gemas Sourced from this {position.asset} Position cancels that much of its Debt. Only your own unspent Gemas count:
        won Gemas and Gemas reserved for Offers cannot be returned. The Position stays locked until Debt reaches zero.
      </p>
      {rows.length > 1 && (
        <div className="wl-actions-row" role="group" aria-label="Advance to return to">
          {rows.map((r, i) => (
            <Button key={r.holding.source.toBase58()} size="sm" aria-pressed={i === pick} onClick={() => { setPick(i); setAmount(Number(r.max)); }}>
              Advance {r.holding.source.toBase58().slice(0, 4)}… · {fmtGemas(Number(r.max))}
            </Button>
          ))}
        </div>
      )}
      <Slider
        label="Gemas to return"
        value={value}
        min={0}
        max={max}
        onChange={setAmount}
        display={<GemaAmount value={value} size="md" />}
        minLabel="0"
        maxLabel={fmtGemas(max)}
      />
      <dl className="kv">
        <dt>Debt now</dt>
        <dd className="tnum">{fmtGemas(debt)} Gemas</dd>
        <dt>Debt after</dt>
        <dd className="tnum">{fmtGemas(debt - value)} Gemas</dd>
      </dl>
      {error && <p className="status err" role="alert">{error}</p>}
      <Button variant="money" block disabled={busy || value === 0 || !auth.signer} onClick={submit}>
        {busy ? "Returning…" : `Return ${fmtGemas(value)} Gemas`}
      </Button>
    </>
  );
}
