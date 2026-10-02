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
            Positions stay on their home chains; Tesoro connects them to the Solana ledger.
          </p>
        </header>
        <div data-reveal>
          <ChainsStage />
        </div>
      </div>
    </section>
  );
}
