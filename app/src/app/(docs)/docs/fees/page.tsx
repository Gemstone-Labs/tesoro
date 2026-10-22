import type { Metadata } from "next";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { fmtGemas } from "@/lib/format";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { PayoutBar } from "@/components/docs/visual";
import { INSTANT_FEE_PCT, INSTANT_PAYOUT_PCT, REDEEM_PAYOUT_PCT, YIELD_FEE_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Fees", alternates: { canonical: "/docs/fees" } };

export default function Page() {
  return (
    <DocPage href="/docs/fees" hero={<PayoutBar />}>
      <H2 id="revenue">How {BRAND.name} earns</H2>
      <p>{BRAND.name} has three sources of revenue, and nothing else. What you lock is never touched by any of them.</p>
      <DataTable
        head={["Fee", "Rate", "Taken from"]}
        rows={[
          ["Platform Fee", "2% of each Pot", "The loser's Gemas, when a Match settles."],
          ["Yield Fee", `${YIELD_FEE_PCT}% of the value`, `Gemas you cash out with Redeem. Never what you lock. Half is ${BRAND.name}'s revenue and half funds the Leaderboard prizes.`],
          ["Instant Redeem Fee", `${INSTANT_FEE_PCT}% of what a Redeem pays`, "Gemas you choose to redeem before their yield has landed, after the Yield Fee."],
        ]}
        caption={`${BRAND.name}'s revenue`}
      />

      <H2 id="yield-fee">Yield Fee</H2>
      <p>
        Gemas are <b>all of the yield</b> a Lock earns, so an Advance is the whole projected yield. {BRAND.name} keeps <b>{YIELD_FEE_PCT}% of the value of Gemas when you cash them out</b>, on every chain: a Redeem pays {REDEEM_PAYOUT_PCT}%, so 1,000 Gemas worth $10.00 pay $8.00. Your Advance is repaid in the same time and your Unlock Estimate does not move. Gemas that pay a Match Fee or a Season prize carry no Yield Fee, and nothing is taken when you Unlock.
      </p>
      <p>
        The {YIELD_FEE_PCT}% is split in two: <b>{YIELD_FEE_PCT / 2}% of the value is {BRAND.name}&apos;s</b> and <b>{YIELD_FEE_PCT / 2}% is owed to the Leaderboard Pool</b> as prizes (see{" "}
        <Link href="/docs/leaderboard">Leaderboard</Link>). Neither half is counted or spent before the cash-out that pays it. {BRAND.name} never spends the Pool&apos;s half, and never spends what holders of an unlocked Lock are still owed.
      </p>

      <H2 id="instant-redeem">Instant Redeem Fee</H2>
      <p>
        Gemas you won normally become redeemable as the yield behind them lands. <b>Instant Redeem</b> skips the wait: you ask {BRAND.name} to buy them, and
        when it fills your request you get <b>{INSTANT_PAYOUT_PCT}%</b> of their value at that moment: the {YIELD_FEE_PCT}% Yield Fee comes out first, then {BRAND.name} keeps <b>{INSTANT_FEE_PCT}%</b> of what is left, and waits for
        the yield itself (1,000 Gemas pay $6.00 now instead of $8.00 later). It is optional, works on Gemas you won and on your own, and only for the part whose yield has not landed yet. You choose how many. See{" "}
        <Link href="/docs/gemas#instant-redeem">Gemas</Link>.
      </p>

      <H2 id="table">Fees on Matches</H2>
      <DataTable
        head={["Fee", "Share of the Pot", "Goes to"]}
        rows={[
          ["Platform Fee", "2%", `${BRAND.name}.`],
          ["Studio Fee", "3% in every Game today; never more than 10%", `The Game's Studio. ${BRAND.name} is the Studio of its own Games.`],
          [<>Leaderboard Fee</>, "1%", <>The Leaderboard Pool, paid to the top Players each week (see <Link href="/docs/leaderboard">Leaderboard</Link>).</>],
          [<b key="t">Total</b>, <b key="p">6%</b>, ""],
        ]}
        caption="Fees on every Match, taken in Gemas at settlement"
      />
      <p>
        On Matches, a draw, a refund or a no-show takes no Fees. Nothing is ever charged on what you lock. Taking an Advance and a normal Redeem cost nothing extra.
      </p>

      <H2 id="who-pays">Who pays</H2>
      <p>
        Fees are taken from the <b>loser&apos;s Gemas</b> at settlement, not from the winner. A winner therefore always receives their own entry back
        whole, plus the loser&apos;s Gemas minus the Fees. Fees are rounded down to whole Gemas, and the leftover fraction goes to the winner.
      </p>

      <H2 id="payout-order">Who is paid first</H2>
      <p>
        Fees reach their owners as Gemas, and Gemas turn into coins as the yield behind them lands. When yield lands on an Advance <i>after</i> a fee
        was taken from it, it repays Gemas in this order:
      </p>
      <ol>
        <li>The Platform Fee Gemas.</li>
        <li>The Studio Fee Gemas of Listed Games (see <Link href="/docs/matches#listed">Listed Games</Link>).</li>
        <li>The Leaderboard Fee Gemas.</li>
        <li>All other Gemas of that Advance, in proportion to what each still waits for.</li>
        <li>Gemas added when the owner Extends the Advance, after everything issued before them.</li>
      </ol>
      <p>
        This only changes who is paid first. It does not change what the Lock owner has left to pay back or the Unlock Estimate. It never lowers what you can
        Redeem now: yield that had already landed on your Gemas stays yours, even when a fee is taken from them, and another holder&apos;s Redeem, an Extend or an Instant Redeem
        cannot reduce it. A Gema keeps its place in the order for its whole life, however often it is won, lost or Backed. The effect is that one
        Match&apos;s fees turn into coins in weeks, not months.
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
        Separate from {BRAND.name}&apos;s fees, every action on a blockchain has a small network cost paid in that chain&apos;s own coin, such as SOL on Solana.
        In Listed Games {BRAND.name} pays this for you on Solana: opening, joining, playing and settling a Match, and redeeming on Solana, need no SOL in your
        wallet, and the refundable rent for your Gemas storage is paid by {BRAND.name} and comes back to it when the storage shrinks. This is only for Accounts that
        hold Gemas, within limits per Account and in total. If {BRAND.name} pauses new Matches because its budget is spent, settling, refunding and redeeming still
        work, and you can pay your own costs if you hold SOL. Messages between chains, such as locking ETH or redeeming to Ethereum, pay a small cross-chain
        delivery cost, paid by whoever sends them. On the test networks the app tops up small amounts for you, and none of it has value.
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
