import { landingArt } from "@/lib/landing/art";
import { LAUNCH_STAGE } from "@/lib/landing/config";
import { Picture } from "./Picture";

/** Coded stand-in for Astra's light paths: three sources, one ledger. */
function Paths() {
  return (
    <svg className="lp-paths" viewBox="0 0 1200 420" preserveAspectRatio="xMidYMid meet" aria-hidden>
      <defs>
        <linearGradient id="lp-path" x1="0" x2="1">
          <stop offset="0" stopColor="#6af8d6" stopOpacity=".15" />
          <stop offset="1" stopColor="#24d8a8" />
        </linearGradient>
        <radialGradient id="lp-node" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#24d8a8" stopOpacity=".55" />
          <stop offset="1" stopColor="#24d8a8" stopOpacity="0" />
        </radialGradient>
      </defs>
      {[90, 210, 330].map((y, i) => (
        <g key={y}>
          <path d={`M150 ${y} C 520 ${y}, 640 210, 930 210`} stroke="url(#lp-path)" strokeWidth={i === 1 ? 3 : 2} fill="none" className="lp-path" />
          <polygon points={hex(118, y, 16 - i * 3)} className="lp-crystal" />
        </g>
      ))}
      <circle cx="1000" cy="210" r="130" fill="url(#lp-node)" />
      <polygon points={octagon(1000, 210, 70, 52, 16)} className="lp-ledger" />
      <polygon points={octagon(1000, 210, 42, 26, 9)} className="lp-ledger-table" />
    </svg>
  );
}

const hex = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");

const octagon = (cx: number, cy: number, a: number, b: number, c: number) =>
  [
    [a - c, -b], [a, -b + c], [a, b - c], [a - c, b], [-a + c, b], [-a, b - c], [-a, -b + c], [-a + c, -b],
  ]
    .map(([x, y]) => `${cx + x},${cy + y}`)
    .join(" ");

export function Multichain() {
  const art = landingArt("multichain");
  return (
    <section id="multichain" className="lp-section lp-multichain" aria-labelledby="multichain-title">
      <div className="lp-wrap">
        <div className={art ? "lp-window has-art cut cut-frame" : "lp-window cut cut-frame"}>
          <div className="lp-window-copy">
            <h2 id="multichain-title" className="lp-h2" data-reveal>
              One ledger, every chain
            </h2>
            <p className="lp-lede lp-measure" data-reveal>
              Positions stay on their home chains; LayerZero V2 connects them to the Solana ledger.
            </p>
          </div>
          <div className="lp-multichain-art" data-wipe>
            {art ? <Picture k="multichain" mobile="multichainMobile" sizes="(max-width: 1240px) 100vw, 1240px" /> : <Paths />}
            <ul className={art ? "lp-chains on-art" : "lp-chains"} aria-label="Chains">
              {["SOL", "ETH", "HYPE"].map((c) => (
                <li key={c} className="chain cut cut-chip">
                  {c}
                </li>
              ))}
            </ul>
          </div>
          {LAUNCH_STAGE === "testnet" && (
            <p className="lp-window-status mono">Solana and Ethereum (Hoodi) are live on testnet; HyperEVM is prepared.</p>
          )}
        </div>
      </div>
    </section>
  );
}
