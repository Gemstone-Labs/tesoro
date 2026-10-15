import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { ChainPath, ThemedArt } from "@/components/docs/visual";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Chains", alternates: { canonical: "/docs/chains" } };

export default function Page() {
  return (
    <DocPage href="/docs/chains" hero={<ThemedArt dark="/art/landing/chains-wide.webp" light="/art/landing/chains-wide-light.webp" ratio="1920 / 800" alt="Solana, Ethereum and HyperEVM shown as three cut stones joined to one ledger" priority />}>
      <H2 id="one-ledger">One ledger, three places to stake</H2>
      <p>
        Gemas, Debt, Matches and Backings all live on <b>Solana</b>. Positions can be opened on Solana, Ethereum or HyperEVM. A Position opened on
        Ethereum or HyperEVM stays there, with its Principal locked in a vault on that chain, and {BRAND.name}&apos;s Solana ledger is told about it. So a
        Gema from any chain plays at the same table and settles in the same place.
      </p>
      <DataTable
        head={["Chain", "Position token", "What you need"]}
        rows={[
          ["Solana", "simSOL", "Just your Account. The app tops up the small fees."],
          ["Ethereum", "simETH", "A little ETH for gas, which the app tops up. Your Ethereum address linked to your Account."],
          ["HyperEVM", "simHYPE", "A little HYPE for gas; the app sends a small amount if your balance is low, with a daily limit."],
        ]}
        caption="Positions you can open"
      />

      <ChainPath />

      <H2 id="what-crosses">What travels between chains</H2>
      <p>Four things cross between an Ethereum-style chain and Solana, carried by LayerZero V2:</p>
      <ul>
        <li><b>Position opened</b>, from the vault to Solana, so the ledger knows the Principal and the yearly rate.</li>
        <li><b>Yield reported</b>, from the vault to Solana, so Debt is repaid and Gemas become redeemable.</li>
        <li><b>Payout</b>, from Solana to the vault, when someone Redeems Gemas that were Sourced from that Position.</li>
        <li><b>Unlock</b>, from Solana to the vault, so the Principal goes back to its owner once the Debt is zero.</li>
      </ul>
      <p>
        Each message takes from under a minute to a few minutes to arrive, and the app shows where it is. Whoever sends a message pays a small
        delivery cost in that chain&apos;s coin.
      </p>

      <H2 id="redeeming">Redeeming across chains</H2>
      <p>
        Gemas Sourced from an Ethereum or HyperEVM Position redeem in that chain&apos;s asset, sent to the holder&apos;s linked address on that chain,
        and only as far as the Position&apos;s yield has accrued. See <Link href="/docs/gemas">Gemas</Link>. A holder must have linked an address on
        that chain family first.
      </p>

      <Callout kind="note" title="Trust on the road">
        <p>
          Cross-chain messages rely on LayerZero&apos;s verification network. A vault will never pay out more than the yield it has actually accrued.
          More in <Link href="/docs/risks">Risks and limits</Link>; developers can follow the flow in{" "}
          <Link href="/docs/developers/cross-chain">Cross-chain with LayerZero V2</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
