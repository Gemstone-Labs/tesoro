import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { PayoutBar } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Fees", alternates: { canonical: "/docs/fees" } };

export default function Page() {
  return (
    <DocPage href="/docs/fees" hero={<PayoutBar />}>
      <H2 id="revenue">How Tesoro earns</H2>
      <p>Tesoro has three sources of revenue, and nothing else. Your Principal is never touched by any of them.</p>
      <DataTable
        head={["Fee", "Rate", "Taken from"]}
        rows={[
          ["Platform Fee", "2% of each Pot", "The loser's Gemas, when a Match settles."],
          ["Yield Fee", "20% of the yield", "Yield your Positions earn, as it arrives. Never the Principal."],
          ["Instant Redeem Fee", "35% of the value", "Won Gemas you choose to redeem before their yield has landed."],
        ]}
        caption="Tesoro's revenue"
      />

      <H2 id="yield-fee">Yield Fee</H2>
      <p>
        Tesoro keeps <b>20% of the yield</b> every Position earns, on every chain. Your Position keeps the other 80%. The Advance is sized on that 80%
        too, so it is still repaid in the same time and your Unlock Estimate does not move.
      </p>

      <H2 id="instant-redeem">Instant Redeem Fee</H2>
      <p>
        Gemas you won normally become redeemable as their Source&apos;s yield lands. <b>Redeem now</b> skips the wait: you get <b>65%</b> of their
        value today and Tesoro keeps <b>35%</b>, then waits for the yield itself. It is optional, and only for Gemas you won. See{" "}
        <Link href="/docs/gemas#instant-redeem">Gemas</Link>.
      </p>

      <H2 id="table">Fees on Matches</H2>
      <DataTable
        head={["Fee", "Share of the Pot", "Goes to"]}
        rows={[
          ["Platform Fee", "2%", "Tesoro."],
          ["Studio Fee", "3% in all three launch Games", "The Game's Studio. Tesoro is the Studio of its own Games."],
          [<>Leaderboard Fee</>, "1%", <>The Leaderboard Pool, paid to the top Players each week (see <Link href="/docs/leaderboard">Leaderboard</Link>).</>],
          [<b key="t">Total</b>, <b key="p">6%</b>, ""],
        ]}
        caption="Fees on every Match, taken in Gemas at settlement"
      />
      <p>
        On Matches, a draw, a refund or a no-show takes no Fees. Nothing is ever charged on your Principal. Taking an Advance and a normal Redeem cost nothing extra.
      </p>

      <H2 id="who-pays">Who pays</H2>
      <p>
        Fees are taken from the <b>loser&apos;s Gemas</b> at settlement, not from the winner. A winner therefore always receives their own entry back
        whole, plus the loser&apos;s Gemas minus the Fees. Fees are rounded down to whole Gemas, and the leftover fraction goes to the winner.
      </p>

      <H2 id="examples">What a win pays</H2>
      <DataTable
        head={["Entry", "Pot", "Platform 2%", "Studio 3%", "Leaderboard 1%", "Winner receives", "Winner's gain"]}
        rows={[
          ["500", "1,000", "20", "30", "10", "940", "+440"],
          ["1,000", "2,000", "40", "60", "20", "1,880", "+880"],
          ["2,500", "5,000", "100", "150", "50", "4,700", "+2,200"],
        ]}
        caption="In Gemas. The loser loses their entry in every case"
      />
      <p>
        With a <Link href="/docs/backing">Backing</Link>, the same Fees come out of the loser&apos;s Gemas first, and then the remainder is split between
        the Backer and the Player by the Offer.
      </p>

      <H2 id="network-costs">Network costs</H2>
      <p>
        Separate from Tesoro&apos;s fees, every action on a blockchain has a small network cost paid in that chain&apos;s own coin, such as SOL on Solana. Messages
        between chains, such as opening an Ethereum Position or redeeming to Ethereum, also pay a small cross-chain delivery cost, paid by whoever sends
        them. On the test networks the app tops up small amounts for you, and none of it has value.
      </p>

      <Callout kind="note" title="Where the numbers come from">
        <p>
          The Platform Fee and each Game&apos;s Studio Fee are set in Tesoro&apos;s ledger program and are fixed when a Match opens, so they cannot
          change after you have entered. The Yield Fee and the Instant Redeem Fee are set there too and shown before you confirm. The Leaderboard Fee is read from the same program when the Match settles. Developers can read them on chain;
          see{" "}
          <Link href="/docs/developers/settlement">How settlement works</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
