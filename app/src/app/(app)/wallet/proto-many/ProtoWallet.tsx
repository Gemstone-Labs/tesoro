"use client";

/**
 * PROTOTYPE (throwaway): five Wallets for an Account with hundreds of Sources, on the real /wallet route.
 * `/wallet?variant=A..E&size=new|regular|heavy`. No `variant` = the real Wallet. Data is a fake Account (fixture.ts).
 */
import { useState } from "react";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { SIZES, makeFixture, type Size } from "./fixture";
import { VariantA, nameA } from "./VariantA";
import { VariantB, nameB } from "./VariantB";
import { VariantC, nameC } from "./VariantC";
import { VariantD, nameD } from "./VariantD";
import { VariantE, nameE } from "./VariantE";
import "./proto.css";

const VARIANTS = [
  { key: "A", name: nameA, C: VariantA },
  { key: "B", name: nameB, C: VariantB },
  { key: "C", name: nameC, C: VariantC },
  { key: "D", name: nameD, C: VariantD },
  { key: "E", name: nameE, C: VariantE },
];

export function ProtoWallet({ variant, size }: { variant: string; size: string }) {
  const [now] = useState(() => Date.now());
  const s = (SIZES as string[]).includes(size) ? (size as Size) : "heavy";
  const v = VARIANTS.find((x) => x.key === variant) ?? VARIANTS[0];
  const f = makeFixture(s, now);
  return (
    <>
      <v.C key={`${v.key}-${s}`} f={f} />
      <PrototypeSwitcher variants={VARIANTS} current={v.key} extra={{ param: "size", values: SIZES, current: s }} />
    </>
  );
}
