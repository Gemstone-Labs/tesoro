/** PROTOTYPE: the few pieces every variant shares (chain tag, state tag, head). */
import { ChainGlyph, GemaMark } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
import { fmtG, fmtUsd, type OwnPosition } from "./fixture";

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;

export function ChainTag({ chain, bare }: { chain: Chain; bare?: boolean }) {
  return (
    <span className={`pm-chain c-${chain}${bare ? " bare" : ""}`}>
      <ChainGlyph asset={GLYPH[chain]} />
      {!bare && chain}
    </span>
  );
}

export function StateTag({ p }: { p: OwnPosition }) {
  return p.state === "paid" ? <span className="pm-tag ok">Paid off</span> : <span className="pm-tag">Repaying</span>;
}

export function Gemas({ n, big }: { n: number; big?: boolean }) {
  return (
    <span className={`pm-gemas${big ? " big" : ""}`}>
      <GemaMark size={big ? 40 : 16} glint={big} />
      <b>{fmtG(n)}</b>
      <small>{fmtUsd(n)}</small>
    </span>
  );
}
