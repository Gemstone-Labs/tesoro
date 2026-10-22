"use client";

// PROTOTYPE preview: the Deposits card takes on sample deposits. DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1). `?card=a|b|c|d`.
import { Suspense, useState } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { ProtoSwitcher } from "@/components/proto/ProtoSwitcher";
import { DEV_WALLET } from "@/lib/chain/config";
import type { DepositRow } from "@/lib/deposit/vault";
import { CARD_VARIANTS, VariantA, VariantB, VariantC, VariantD } from "../../vault/proto-deposits/DepositsCardProto";
import "../../vault/vault.css";

const MIN = 60_000;
function sample(now: number): DepositRow[] {
  return [
    { id: "d1", label: "Deposit 1", sol: 1.6, worthUsd: 251, gemasGiven: 1400, state: "ready", backAtMs: null, openedAtMs: now - 130 * MIN },
    { id: "d2", label: "Deposit 2", sol: 3.2, worthUsd: 498, gemasGiven: 2800, state: "growing", backAtMs: now + 47 * MIN, openedAtMs: now - 73 * MIN },
    { id: "d3", label: "Deposit 3", sol: 0.65, worthUsd: 101, gemasGiven: 560, state: "growing", backAtMs: now + 112 * MIN, openedAtMs: now - 8 * MIN },
    { id: "d4", label: "Deposit 4", sol: 3.2, worthUsd: 502, gemasGiven: 2800, state: "late", backAtMs: now + 20 * MIN, openedAtMs: now - 140 * MIN },
  ];
}

function Preview() {
  const params = useSearchParams();
  const card = params.get("card") ?? "a";
  const only = params.get("only");
  const [now] = useState(() => Date.now());
  const all = sample(now);
  const deposits = only ? all.filter((d) => only.split(",").includes(d.id)) : all;
  const p = { deposits, busyId: null, canWithdraw: true, onWithdraw: () => {}, extras: <p className="note">1 earlier deposit withdrawn.</p> };
  return (
    <div className="wl">
      <div className="vt-below">
        {card === "a" && <VariantA {...p} />}
        {card === "b" && <VariantB {...p} />}
        {card === "c" && <VariantC {...p} />}
        {card === "d" && <VariantD {...p} />}
      </div>
      <ProtoSwitcher param="card" variants={CARD_VARIANTS.filter((v) => v.key !== "today")} current={card} />
    </div>
  );
}

export default function DepositsPreview() {
  if (!DEV_WALLET) notFound();
  return (
    <Suspense>
      <Preview />
    </Suspense>
  );
}
