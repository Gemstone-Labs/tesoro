import type { Metadata } from "next";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { fmtGemas } from "@/lib/format";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { PayoutBar } from "@/components/docs/visual";
import { INSTANT_FEE_PCT, INSTANT_PAYOUT_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Fees", alternates: { canonical: "/docs/fees" } };

export default function Page() {
  return (
    <DocPage href="/docs/fees" hero={<PayoutBar />}>
      <H2 id="revenue">How {BRAND.name} earns</H2>
      <p>{BRAND.name} has three sources of revenue, and nothing else. Your Principal is never touched by any of them.</p>
      <DataTable
        head={["Fee", "Rate", "Taken from"]}
        rows={[
          ["Platform Fee", "2% of each Pot", "The loser's Gemas, when a Match settles."],
          ["Yield Fee", "20% of the yield", "Yield your Positions earn, as it arrives. Never the Principal."],
          ["Instant Redeem Fee", `${INSTANT_FEE_PCT}% of the value`, "Won Gemas you choose to redeem before their yield has landed."],
        ]}
        caption={`${BRAND.name}'s revenue`}
      />

      <H2 id="yield-fee">Yield Fee</H2>
      <p>
        {BRAND.name} keeps <b>20% of the yield</b> every Position earns, on every chain. Your Position keeps the other 80%. The Advance is sized on that 80%
        too, so it is still repaid in the same time and your Unlock Estimate does not move.
      </p>

      <H2 id="instant-redeem">Instant Redeem Fee</H2>
      <p>
        Gemas you won normally become redeemable as their Source&apos;s yield lands. <b>Redeem now</b> skips the wait: you get <b>{INSTANT_PAYOUT_PCT}%</b> of their
        value today and {BRAND.name} keeps <b>{INSTANT_FEE_PCT}%</b>, then waits for the yield itself. It is optional, and only for Gemas you won. See{" "}
        <Link href="/docs/gemas#instant-redeem">Gemas</Link>.
      </p>

      <H2 id="table">Fees on Matches</H2>
      <DataTable
        head={["Fee", "Share of the Pot", "Goes to"]}
        rows={[
          ["Platform Fee", "2%", `${BRAND.name}.`],
          ["Studio Fee", "3% in every Game", `The Game's Studio. ${BRAND.name} is the Studio of its own Games.`],
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
        rows={ENTRY_SIZES.map((e) => {
          const pot = e * 2;
          const [platform, studio, board] = [pot * 0.02, pot * 0.03, pot * 0.01];
          const win = pot - platform - studio - board;
          return [e, pot, platform, studio, board, win, `+${fmtGemas(win - e)}`].map((v) => (typeof v === "number" ? fmtGemas(v) : v));
        })}
        caption="In Gemas. The loser loses their entry in every case"
      />
      <p>
        With a <Link href="/docs/backing">Backing</Link>, the same Fees come out of the loser&apos;s Gemas first, and then the remainder is split between
        the Backer and the Player by the Offer.
      </p>

      <H2 id="network-costs">Network costs</H2>
      <p>
        Separate from {BRAND.name}&apos;s fees, every action on a blockchain has a small network cost paid in that chain&apos;s own coin, such as SOL on Solana. Messages
        between chains, such as opening an Ethereum Position or redeeming to Ethereum, also pay a small cross-chain delivery cost, paid by whoever sends
        them. On the test networks the app tops up small amounts for you, and none of it has value.
      </p>

      <Callout kind="note" title="Where the numbers come from">
        <p>
          The Platform Fee and each Game&apos;s Studio Fee are set in {BRAND.name}&apos;s ledger program and are fixed when a Match opens, so they cannot
          change after you have entered. The Yield Fee and the Instant Redeem Fee are set there too and shown before you confirm. The Leaderboard Fee is read from the same program when the Match settles. Developers can read them on chain;
          see{" "}
          <Link href="/docs/developers/settlement">How settlement works</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
