import { DEPLOYMENTS, short } from "@/lib/landing/status";

/** Testnet only: where it runs today, with every address linked to its explorer. */
export function StatusBand() {
  return (
    <section id="status" className="lp-status" aria-labelledby="status-title">
      <div className="lp-wrap">
        <p className="lp-status-head mono">
          <span id="status-title">Live on testnet</span> · Simulated · 1 month = 10 min
        </p>
        <dl className="lp-status-list mono">
          {DEPLOYMENTS.map((g) => (
            <div key={g.chain}>
              <dt>{g.chain}</dt>
              {g.items.map((d) => (
                <dd key={d.address}>
                  {d.name}{" "}
                  <a href={d.href} target="_blank" rel="noopener noreferrer" title={d.address}>
                    {short(d.address)} ↗
                  </a>
                </dd>
              ))}
            </div>
          ))}
        </dl>
        <p className="lp-status-note mono">Yield on testnet is simulated until mainnet. Nothing here has real value.</p>
      </div>
    </section>
  );
}
