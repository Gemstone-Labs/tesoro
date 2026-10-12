import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { Coins, Gem, Lock, RefreshCcw, Swords } from "lucide-react";
import { FlowDiagram, Shot, StepGrid } from "@/components/docs/visual";

export const metadata: Metadata = { title: "How Tesoro works", alternates: { canonical: "/docs/how-it-works" } };

export default function Page() {
  return (
    <DocPage href="/docs/how-it-works" hero={<FlowDiagram />}>
      <H2 id="five-steps">Five steps</H2>
      <StepGrid
        items={[
          { icon: Lock, tone: "emerald", title: "Open a Position", body: <>Lock a staking token in your Wallet. Its Principal is locked and never played.</> },
          { icon: Coins, tone: "emerald", title: "Take an Advance", body: <>Pick a Horizon of 1 to 12 months. You receive 100% of the Position&apos;s projected yield over it, upfront.</> },
          { icon: Gem, tone: "emerald", title: "Hold Gemas", body: <>The Advance arrives as Gemas, worth $0.01 each at the moment they are issued.</> },
          { icon: Swords, tone: "sapphire", title: "Play Matches", body: <>Enter 500, 1,000 or 2,500 Gemas in a head-to-head game. The winner takes the Pot minus Fees.</> },
          { icon: RefreshCcw, tone: "emerald", title: "Repay and Redeem", body: <>Your Position&apos;s yield repays its Debt on its own. Gemas you win turn into their Source asset as the loser&apos;s yield lands.</> },
        ]}
        result={{ title: "What you have at the end", body: <>Your Principal back after Unlock, plus whatever you won and redeemed. Matches only ever risk the Gemas you enter.</> }}
      />

      <Shot name="lobby" url="playtesoro.com/lobby" alt="The Tesoro Lobby with the three Games, entry sizes and a Play now button" caption="The Lobby: pick a Game and an entry, then Play now." />

      <H2 id="worked-example">A worked example</H2>
      <p>
        Say you lock 10 simSOL at 7% a year and pick a 3 month Horizon. The price used here, $100 a SOL, is only for the arithmetic.
      </p>
      <DataTable
        head={["Step", "Working", "Result"]}
        rows={[
          ["Projected yield", "10 × 7% × 3 ÷ 12", "0.175 SOL"],
          ["Worth at issuance", "0.175 × $100", "$17.50"],
          ["Gemas issued", "$17.50 ÷ $0.01", "1,750 Gemas"],
          ["Debt", "all of the Advance", "1,750 Gemas"],
        ]}
        caption="Advance = Principal × yearly rate × months ÷ 12, priced once and rounded down to whole Gemas"
      />
      <p>
        After that the dollar price is never used again. Your Debt is fixed in the Position&apos;s own asset, so a later price move changes neither
        the Debt nor what a Gema redeems for.
      </p>
      <p>
        Yield runs on a fast clock where a month takes 10 minutes, so 3 months of yield arrive in about 30 minutes and the Debt falls to zero on its own.
      </p>

      <H2 id="what-never-happens">What never happens</H2>
      <ul>
        <li>Principal is never entered into a Match.</li>
        <li>Principal never pays Debt. Adding more to a Position does not repay it either.</li>
        <li>Nothing is charged on Principal, on an Advance or on Redeem. Tesoro&apos;s fees are taken only from Matches (see <Link href="/docs/fees">Fees</Link>).</li>
        <li>Tesoro does not lend you money against your Principal. An Advance is your own projected yield, paid early.</li>
      </ul>

      <H2 id="why-pvp-only">Why only head-to-head games</H2>
      <p>
        Gemas are claims on yield that has not arrived yet. In a head-to-head Match the person paid is the winner, who can wait: they receive the
        loser&apos;s Gemas and redeem them as that yield lands. In a shop, the seller would need to be paid today, and someone would have to lend
        against your future yield. Tesoro does not do that, so Gemas are spent only on contests between Players.
      </p>

      <Callout kind="note" title="Where to read next">
        <p>
          <Link href="/docs/positions">Positions and Advances</Link> covers the lock in detail, <Link href="/docs/gemas">Gemas</Link> explains
          what a Gema is a claim on, and <Link href="/docs/matches">Games and Matches</Link> has the rules of each game.
        </p>
      </Callout>
    </DocPage>
  );
}
