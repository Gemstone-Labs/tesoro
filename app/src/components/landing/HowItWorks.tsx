import { Compass, Lock, Spade, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import type { LandingKey } from "@/lib/landing/art";
import { landingArt } from "@/lib/landing/art";
import { Picture } from "./Picture";

const STEPS: { title: string; body: ReactNode; art: LandingKey; icon: ReactNode }[] = [
  {
    title: "Open a Position",
    body: "Stake SOL, ETH or HYPE into a Position. Its Principal stays locked while you have Debt, and is never played.",
    art: "step1",
    icon: <Lock aria-hidden />,
  },
  {
    title: "Take an Advance",
    body: (
      <>
        Get <b data-count="100" data-suffix="%">100%</b> of your Position&rsquo;s projected yield over a{" "}
        <b>1&ndash;<span data-count="12">12</span></b>-month Horizon, upfront.
      </>
    ),
    art: "step2",
    icon: <Compass aria-hidden />,
  },
  {
    title: "Get Gemas",
    body: "Your Advance arrives as Gemas: one play unit on every chain.",
    art: "step3",
    icon: <GemaMark size={28} />,
  },
  {
    title: "Play head-to-head Matches",
    body: (
      <>
        Enter <b data-count="500">500</b>, <b data-count="1000">1,000</b> or <b data-count="2500">2,500</b> Gemas. The winner takes the Pot, minus Fees.
      </>
    ),
    art: "step4",
    icon: <Spade aria-hidden />,
  },
  {
    title: "Redeem",
    body: "Winners redeem as the losers’ yield actually accrues. Your Debt repays itself from yield.",
    art: "step5",
    icon: <Undo2 aria-hidden />,
  },
];

export function HowItWorks() {
  const guide = landingArt("himGuide");
  return (
    <section id="how-it-works" className="lp-section lp-how" aria-labelledby="how-title">
      <div className="lp-wrap lp-how-grid">
        <div className="lp-how-guide" aria-hidden data-parallax="-0.08">
          {guide ? (
            <Picture k="himGuide" sizes="(max-width: 1023px) 200px, 30vw" />
          ) : (
            <picture>
              <img src={art.busts.himExplain.src} width={art.busts.himExplain.w} height={art.busts.himExplain.h} alt="" loading="lazy" />
            </picture>
          )}
        </div>
        <div>
          <h2 id="how-title" className="lp-h2" data-reveal>
            How it works
          </h2>
          <ol className="lp-steps" data-rail>
            {STEPS.map((s, i) => (
              <li key={s.title} className="lp-step" data-reveal>
                <div className="lp-step-art cut cut-card" aria-hidden>
                  {landingArt(s.art) ? <Picture k={s.art} sizes="96px" /> : <span className="lp-step-icon">{s.icon}</span>}
                </div>
                <div>
                  <p className="lp-step-n mono">0{i + 1}</p>
                  <h3 className="lp-h3">{s.title}</h3>
                  <p className="lp-body">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
