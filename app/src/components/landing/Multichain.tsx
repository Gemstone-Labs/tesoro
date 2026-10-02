import { LAUNCH_STAGE } from "@/lib/landing/config";
import { ChainsStage } from "./chains/ChainsStage";

export function Multichain() {
  return (
    <section id="multichain" className="lp-section lp-multichain" aria-labelledby="multichain-title">
      <div className="lp-wrap">
        <header className="lp-center-head">
          <h2 id="multichain-title" className="lp-h2" data-reveal>
            One ledger, every chain
          </h2>
          <p className="lp-lede" data-reveal>
            Positions stay on their home chains; LayerZero V2 connects them to the Solana ledger.
          </p>
        </header>
        <div data-reveal>
          <ChainsStage />
        </div>
        {LAUNCH_STAGE === "testnet" && <p className="lp-chains-status mono">Solana and Ethereum (Hoodi) are live on testnet; HyperEVM is prepared.</p>}
      </div>
    </section>
  );
}
