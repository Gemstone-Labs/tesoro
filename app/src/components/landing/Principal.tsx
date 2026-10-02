import { Info, LockOpen, ShieldCheck, Sprout } from "lucide-react";
import { landingArt } from "@/lib/landing/art";
import { Picture } from "./Picture";
import { Vault } from "./Vault";

const FACTS = [
  { icon: <ShieldCheck aria-hidden />, title: "Never played", body: "The Principal never enters a Match and is never spent." },
  { icon: <Sprout aria-hidden />, title: "Only yield pays Debt", body: "The Position’s own yield repays the Advance, Source by Source." },
  { icon: <LockOpen aria-hidden />, title: "Unlocks at zero", body: "When Debt reaches zero the Position unlocks." },
];

export function Principal() {
  return (
    <section id="principal" className="lp-section lp-principal" aria-labelledby="principal-title">
      <div className="lp-wrap lp-principal-grid">
        <div>
          <h2 id="principal-title" className="lp-h2" data-reveal>
            Your Principal is never played
          </h2>
          <p className="lp-lede lp-measure" data-reveal>
            You play with the yield your stake will earn, never with the stake itself.
          </p>
          <ul className="lp-facts-list">
            {FACTS.map((f) => (
              <li key={f.title} data-reveal>
                <span className="lp-fact-icon cut cut-chip">{f.icon}</span>
                <span>
                  <b>{f.title}</b>
                  <span className="lp-body">{f.body}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="lp-note" data-reveal>
            <Info aria-hidden />
            Your Position stays locked while you have Debt, and it still carries the staking provider&rsquo;s risk and the asset&rsquo;s market risk.
          </p>
        </div>
        <Vault
          locked={landingArt("step1") && <Picture k="step1" sizes="260px" className="closed" />}
          open={landingArt("step5") && <Picture k="step5" sizes="260px" className="open" />}
        />
      </div>
    </section>
  );
}
