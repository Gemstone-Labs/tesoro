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

      <H2 id="instant-redeem">Redeem now</H2>
      <p>
        If you do not want to wait for a Lock&apos;s yield, you can <b>Redeem now</b> Gemas you won. You receive <b>{INSTANT_PAYOUT_PCT}%</b> of their value in the
        coin they came from today. {BRAND.name} keeps the other <b>{INSTANT_FEE_PCT}%</b>, takes the Gemas and waits for the yield itself, so you never have to.
      </p>
      <ul>
        <li>It works for SOL, ETH and HYPE Gemas you won. Your own Gemas, the ones from your own Locks, cannot be redeemed this way.</li>
        <li>It is optional. A normal Redeem pays 100% once the yield has landed.</li>
        <li>It only sells Gemas whose yield has not landed yet. Any part that has already landed is redeemed at full value in the same step.</li>
        <li>It is limited by what {BRAND.name} holds for that asset. If it holds less than your payout, the Redeem now is refused and nothing moves.</li>
        <li>The Lock and what is left to pay back on it are untouched: {BRAND.name} simply becomes the holder of those Gemas.</li>
      </ul>

      <H2 id="own-first">Which Gemas an entry uses</H2>
      <p>
        When you enter a Match, {BRAND.name} uses your <b>own</b> Gemas first, the ones from your own Locks, and then Gemas you won. That keeps
        Gemas that came home counted as yours. An entry can draw on Gemas from up to 8 different Advances. If your Gemas are spread over more than 8 small batches,
        redeem some of the small balances first.
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
