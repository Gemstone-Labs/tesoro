import { ChainsStage } from "./chains/ChainsStage";
import { BRAND } from "@/lib/brand";

export function Multichain() {
  return (
    <section id="multichain" className="lp-section lp-multichain" aria-labelledby="multichain-title">
      <div className="lp-wrap">
        <header className="lp-center-head">
          <h2 id="multichain-title" className="lp-h2" data-reveal>
            One ledger, every chain
          </h2>
          <p className="lp-lede" data-reveal>
            Locks stay on their home chains; {BRAND.name} connects them to the Solana ledger.
          </p>
        </header>
        <div data-reveal>
          <ChainsStage />
        </div>
      </div>
    </section>
  );
}
