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
        also a redeemable claim on its <b>Source</b>: the Advance it was issued from.
      </p>
      <p>
        At the table, all Gemas are equal. At redemption they are not: the Source fixes the asset and the amount a Gema redeems for, so a Gema issued
        from an ETH Position redeems in ETH, and one from a SOL Position in SOL.
      </p>

      <H2 id="source">Source</H2>
      <p>
        The dollar price is used once, when the Advance is issued. From then on a Gema is an amount of the Source asset. A later move in the asset&apos;s
        price changes neither the Debt nor what a Gema redeems for, measured in that asset.
      </p>
      <p>
        When you win a Match you receive the loser&apos;s actual Gemas, each keeping its Source. A winner can end up holding a basket of claims on
        several Positions and several chains. Your Wallet shows these by Source, split into <b>redeemable now</b> and <b>pending</b>.
      </p>

      <H2 id="redeem">Redeem</H2>
      <p>
        To <b>Redeem</b> is to turn Gemas into their Source asset. It is possible only as far as the Source Position&apos;s yield has actually
        accrued. For each Source, the Gemas you can redeem are your share of the Gemas that yield has already covered, so redemption never pays out
        more than the yield that exists.
      </p>
      <DataTable
        head={["Situation", "What it means for Redeem"]}
        rows={[
          ["The Source's yield has covered its Debt and more", "Your Gemas from that Source are redeemable now."],
          ["The Source's Debt is not yet repaid", "Your Gemas from that Source are pending and become redeemable as its yield lands."],
          ["The Source's yield slows down", "Pending Gemas wait longer. There is no deadline and no guarantee of a date."],
        ]}
      />
      <p>
        Redeem pays out in the Source asset: simSOL on Solana, simETH on Ethereum or simHYPE on HyperEVM. Redeeming an
        Ethereum or HyperEVM Gema, now or later, sends a message to that chain, which takes a few minutes (see <Link href="/docs/chains">Chains</Link>).
      </p>

      <Shot name="wallet" url={`${BRAND.domain}/wallet`} alt="The Wallet listing Gemas by Source, redeemable now and pending" caption="Gemas by Source in the Wallet, split into redeemable now and pending. Sample data." />

      <H2 id="instant-redeem">Redeem now</H2>
      <p>
        If you do not want to wait for a Source&apos;s yield, you can <b>Redeem now</b> Gemas you won. You receive <b>{INSTANT_PAYOUT_PCT}%</b> of their value in the
        Source asset today. {BRAND.name} keeps the other <b>{INSTANT_FEE_PCT}%</b>, takes the Gemas and waits for the yield itself, so you never have to.
      </p>
      <ul>
        <li>It works for SOL, ETH and HYPE Gemas you won. Your own Gemas, the ones from your own Positions, cannot be redeemed this way.</li>
        <li>It is optional. A normal Redeem pays 100% once the yield has landed.</li>
        <li>It only sells Gemas whose yield has not landed yet. Any part that has already landed is redeemed at full value in the same step.</li>
        <li>It is limited by what {BRAND.name} holds for that asset. If it holds less than your payout, the Redeem now is refused and nothing moves.</li>
        <li>The Source and its Debt are untouched: {BRAND.name} simply becomes the holder of those Gemas.</li>
      </ul>

      <H2 id="own-first">Which Gemas an entry uses</H2>
      <p>
        When you enter a Match, {BRAND.name} uses your <b>own-Sourced</b> Gemas first, the ones from your own Positions, and then Gemas you won. That keeps
        Gemas that came home counted as yours. An entry can draw on up to 8 different Sources. If your Gemas are spread over more than 8 small Sources,
        redeem some of the small balances first.
      </p>

      <H3 id="no-other-uses">What Gemas are not</H3>
      <ul>
        <li>They are not a token you can trade, and not a currency for buying things.</li>
        <li>They are spent only on contests between Players (see <Link href="/docs/matches">Games and Matches</Link>).</li>
        <li>They are not a promise of any particular amount of the Source asset until the Source&apos;s yield has accrued.</li>
      </ul>

      <Callout kind="note" title="Terms in the app">
        <p>
          The app and these docs use the same words everywhere: Position, Principal, Advance, Horizon, Gema, Source, Debt, Match, Pot, Queue,
          Challenge, Backing.
        </p>
      </Callout>
    </DocPage>
  );
}
