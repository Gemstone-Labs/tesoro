import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { Shot, SourceDiagram } from "@/components/docs/visual";
import { INSTANT_FEE_PCT, INSTANT_PAYOUT_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Gemas", alternates: { canonical: "/docs/gemas" } };

export default function Page() {
  return (
    <DocPage href="/docs/gemas" hero={<SourceDiagram />}>
      <H2 id="what">What a Gema is</H2>
      <p>
        <b>Gemas</b> are the one play unit on {BRAND.name}, the same on every chain. A Gema is worth <b>$0.01 at the moment it is issued</b>. Every Gema is
        also a redeemable claim on the coin of the Lock it came from, through the Advance it was issued from.
      </p>
      <p>
        At the table, all Gemas are equal. At redemption they are not: the Lock it came from fixes the coin and the amount a Gema redeems for, so a Gema issued
        from an ETH Lock redeems in ETH, and one from a SOL Lock in SOL.
      </p>

      <H2 id="source">Where a Gema came from</H2>
      <p>
        The dollar price is used once, when the Advance is issued. From then on a Gema is an amount of that Lock&apos;s coin. A later move in the coin&apos;s
        price changes neither what is left to pay back nor what a Gema redeems for, measured in that asset.
      </p>
      <p>
        When you win a Match you receive the loser&apos;s actual Gemas, each keeping the Lock it came from. A winner can end up holding a basket of claims on
        several Locks and several chains. Your Wallet shows these by coin, split into <b>redeemable now</b> and <b>pending</b>.
      </p>

      <H2 id="redeem">Redeem</H2>
      <p>
        To <b>Redeem</b> is to turn Gemas into the coin they came from. It is possible only as far as that Lock&apos;s yield has actually
        been earned. For each Lock, the Gemas you can redeem are your share of the Gemas that yield has already covered, so redemption never pays out
        more than the yield that exists.
      </p>
      <p>
        <b>Redeem now</b> is the amount your Gemas on one chain can be Redeemed for at full value at this moment. It never goes down unless you Redeem or
        spend those Gemas: another holder&apos;s Redeem, the Lock owner&apos;s Extend, a new fee or an Instant Redeem cannot lower it. For the rest the Wallet
        shows an estimated date it will be ready by. Which Gemas are repaid first is set by the{" "}
        <Link href="/docs/fees#payout-order">payout order</Link>.
      </p>
      <p>
        Your Gemas are claims on the staking token behind them, not on a fixed amount. If the staking token loses value, for example when its protocol is
        slashed, the value of the Gemas that had already been repaid falls with it, exactly as if you had held the token. {BRAND.name} does not make up the loss.
      </p>
      <DataTable
        head={["Situation", "What it means for Redeem"]}
        rows={[
          ["The Lock's yield has paid back its Advance and more", "Your Gemas from that Lock are redeemable now."],
          ["The Lock's Advance is not yet paid back", "Your Gemas from that Lock are pending and become redeemable as its yield lands."],
          ["The Lock's yield slows down", "Pending Gemas wait longer. There is no deadline and no guarantee of a date."],
        ]}
      />
      <p>
        Redeem pays out in the coin the Gemas came from: test SOL on Solana, test ETH on Ethereum or test HYPE on HyperEVM. Redeeming an
        Ethereum or HyperEVM Gema, now or later, sends a message to that chain, which takes a few minutes (see <Link href="/docs/chains">Chains</Link>).
      </p>

      <Shot name="wallet" url={`${BRAND.domain}/wallet`} alt="The Wallet listing Gemas by coin, redeemable now and pending" caption="Gemas by coin in the Wallet, split into redeemable now and pending. Sample data." />

      <H2 id="instant-redeem">Instant Redeem</H2>
      <p>
        If you do not want to wait for a Lock&apos;s yield, you can ask for an <b>Instant Redeem</b> of Gemas you won. It is an order: you make the request, the Gemas
        wait in the order, and {BRAND.name} fills it. When it does you receive <b>{INSTANT_PAYOUT_PCT}%</b> of their value, counted at the moment of the fill, in the
        coin they came from. {BRAND.name} keeps the other <b>{INSTANT_FEE_PCT}%</b>, takes the Gemas and waits for the yield itself, so you never have to.
      </p>
      <ul>
        <li>It works for SOL, ETH and HYPE Gemas you won. Your own Gemas, the ones from your own Locks, cannot be sold this way.</li>
        <li>It is optional. A normal Redeem pays 100% once the yield has landed.</li>
        <li>{BRAND.name} may fill an order in full or in part, and not at once. While it waits, those Gemas cannot be played. You can cancel an unfilled order at any time, and an order nobody fills expires and gives your Gemas back unchanged.</li>
        <li>It only sells Gemas whose yield has not landed yet. Any part that has already landed, including yield that lands while the order waits, is redeemed for you at full value.</li>
        <li>It is limited by what {BRAND.name} can spend for that asset. The Treasury never spends the Leaderboard Pool&apos;s share, or what holders of an unlocked Lock are still owed. If it cannot pay, the order simply waits.</li>
        <li>The Lock and what is left to pay back on it are untouched: {BRAND.name} simply becomes the holder of those Gemas.</li>
      </ul>

      <H2 id="own-first">Which Gemas an entry uses</H2>
      <p>
        When you enter a Match, the program, not the app, chooses the Gemas. It uses your <b>own</b> Gemas first, the ones from your own Locks, and then
        Gemas you won. Among won Gemas, <b>the Gemas whose planned repayment date is earliest are spent first</b>: that is the date their Lock is projected to
        finish paying them back. Nobody can pick a different order, so the Gemas your opponent wins from you are the fastest ones you had.
      </p>
      <p>
        You can hold Gemas from any number of Advances. If an entry needs more pieces than one transaction can carry, the app puts it together in
        steps (an Entry Ticket) and then enters. While a Ticket is open your other entries wait; you can cancel it, and if you walk away it expires and gives
        everything back untouched. If your free Gemas cover the entry, you can always enter. The Wallet has a &ldquo;Redeem small leftovers&rdquo; action to tidy tiny
        amounts. When you win from a new Advance your storage grows by itself at no cost to you.
      </p>

      <H3 id="no-other-uses">What Gemas are not</H3>
      <ul>
        <li>They are not a token you can trade, and not a currency for buying things.</li>
        <li>They are spent only on contests between Players (see <Link href="/docs/matches">Games and Matches</Link>).</li>
        <li>They are not a promise of any particular amount of the coin until the Lock&apos;s yield has been earned.</li>
      </ul>

      <Callout kind="note" title="Terms in the app">
        <p>
          The app and these docs use the same words everywhere: Lock, Locked amount, Advance, Length, Gema, Match, Pot, Queue,
          Challenge, Backing.
        </p>
      </Callout>
    </DocPage>
  );
}
