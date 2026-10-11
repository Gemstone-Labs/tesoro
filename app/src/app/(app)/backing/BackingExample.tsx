"use client";

import { Button, GemaMark } from "@/components/ui";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { VariantA, VariantB, VariantC, VariantD } from "./BackingExample.prototype";

// PROTOTYPE: ?variant=now|A|B|C|D
const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Pot split" },
  { key: "B", name: "Try it" },
  { key: "C", name: "Three steps" },
  { key: "D", name: "Outcome posters" },
] as const;

export function BackingExample({ onPost }: { onPost: () => void }) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  const View = { now: BackingExampleNow, A: VariantA, B: VariantB, C: VariantC, D: VariantD }[v];
  return (
    <>
      <View onPost={onPost} />
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/** A worked Offer for the empty Requests tab. Fees are the test-mode registry's (2% Platform + 3% Studio) plus the 1% Leaderboard Fee. */
const EXAMPLE = { entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS, shareBps: 5000 };

function Gemas({ n }: { n: number }) {
  return (
    <b className="tnum bk-ex-n">
      <GemaMark size={14} />
      {fmtGemas(n)}
    </b>
  );
}

/** HOW BACKING WORKS: shown while there are no live Requests, with the real split rule applied to one example Offer. */
function BackingExampleNow({ onPost }: { onPost: () => void }) {
  const win = backedSplit({ ...EXAMPLE, won: true });
  const loss = backedSplit({ ...EXAMPLE, won: false });
  return (
    <section className="cut cut-card bk-span bk-ex" aria-labelledby="bk-ex-h">
      <div className="bk-ex-lead">
        <h2 id="bk-ex-h" className="h-section">How Backing works</h2>
        <p>
          A Backer pays a Player’s whole entry. Example: you Offer to back a <Gemas n={EXAMPLE.entry} /> Match, and the Player keeps {EXAMPLE.shareBps / 100}% of the surplus.
        </p>
        <Button variant="money" onClick={onPost}>Post a Request</Button>
      </div>
      <dl className="bk-ex-cases">
        <div>
          <dt>If the Player wins</dt>
          <dd>
            You get your <Gemas n={win.backerEntryBack} /> back plus <Gemas n={win.backerSurplus} />. The Player gets <Gemas n={win.playerShare} />. Fees: <Gemas n={win.fees} />.
          </dd>
        </div>
        <div>
          <dt>If the Player loses</dt>
          <dd>
            You lose the <Gemas n={-loss.backerNet} /> entry. The Player loses nothing.
          </dd>
        </div>
      </dl>
    </section>
  );
}
