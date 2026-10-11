"use client";

import dynamic from "next/dynamic";
import { Stage3D } from "../Stage3D";
import { ASPECT, CHAINS, LEDGER, toStage, type ChainsLayout } from "./layout";

const ChainsCanvas = dynamic(() => import("./ChainsCanvas"), { ssr: false });

function Labels({ layout }: { layout: ChainsLayout }) {
  const [lx, ly, lz] = LEDGER[layout];
  return (
    <ul className="lp-chain-labels" aria-hidden>
      {CHAINS.map((c) => {
        const [x, y, z] = c.at[layout];
        const at = layout === "wide" ? toStage([x - 0.95, y, z], layout) : toStage([x, y + 0.85, z], layout);
        return (
          <li key={c.label} className="chain cut cut-chip" style={at}>
            {c.label}
          </li>
        );
      })}
      <li className="ledger" style={toStage([lx, ly - (layout === "wide" ? 1.15 : 0.95), lz], layout)}>
        <b>Tesoro ledger</b>
        <span>on Solana · Gemas, Matches, Backings</span>
      </li>
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
          poster={(["", "-light"] as const).map((t) => (
            <picture key={t} className={t ? "on-light" : "on-dark"}>
              <source type="image/avif" srcSet={`/art/landing/chains-${layout}${t}.avif`} />
              <img src={`/art/landing/chains-${layout}${t}.webp`} alt="" loading="lazy" decoding="async" />
            </picture>
          ))}
        >
          <Labels layout={layout} />
          <span className="lp-chains-aspect" style={{ aspectRatio: String(ASPECT[layout]) }} />
        </Stage3D>
      ))}
    </>
  );
}
