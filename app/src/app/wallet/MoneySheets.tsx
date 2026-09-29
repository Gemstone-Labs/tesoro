"use client";

import { useState } from "react";
import { Button, CheckIcon, ChainChip, GemaAmount, Sheet, Slider } from "@/components/ui";
import { gemasToAsset } from "@/lib/advance";
import { redeemableOf, useAccount } from "@/lib/account";
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
