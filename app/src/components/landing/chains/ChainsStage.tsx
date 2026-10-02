"use client";

import dynamic from "next/dynamic";
import { Stage3D } from "../Stage3D";
import { ASPECT, CHAINS, toStage, type ChainsLayout } from "./layout";

const ChainsCanvas = dynamic(() => import("./ChainsCanvas"), { ssr: false });

function Labels({ layout }: { layout: ChainsLayout }) {
  return (
    <ul className="lp-chain-labels" aria-hidden>
      {CHAINS.map((c) => {
        const [x, y, z] = c.at[layout];
        const at = layout === "wide" ? toStage([x - 0.8, y, z], layout) : toStage([x, y + 0.85, z], layout);
        return (
          <li key={c.label} className="chain cut cut-chip" style={at}>
            {c.label}
          </li>
        );
      })}
    </ul>
  );
}

/** Three sources, one ledger: live on desktop, our own render of the same scene elsewhere (wide, or tall on phones). */
export function ChainsStage() {
  return (
    <>
      {(["wide", "tall"] as const).map((layout) => (
        <Stage3D
          key={layout}
          Canvas={ChainsCanvas}
          layout={layout}
          className={`lp-chains-stage ${layout}`}
          poster={
            <picture>
              <source type="image/avif" srcSet={`/art/landing/chains-${layout}.avif`} />
              <img src={`/art/landing/chains-${layout}.webp`} alt="" loading="lazy" decoding="async" />
            </picture>
          }
        >
          <Labels layout={layout} />
          <span className="lp-chains-aspect" style={{ aspectRatio: String(ASPECT[layout]) }} />
        </Stage3D>
      ))}
    </>
  );
}
