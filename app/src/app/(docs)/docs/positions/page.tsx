import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { DebtDiagram, Shot } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Positions and Advances", alternates: { canonical: "/docs/positions" } };

export default function Page() {
  return (
    <DocPage href="/docs/positions" hero={<DebtDiagram />}>
      <H2 id="position">A Position</H2>
      <p>
        A <b>Position</b> is your locked, yield-bearing stake in Tesoro. The staked amount inside it is the <b>Principal</b>. The Principal is only
        ever locked: it is never entered into a Match, never spent, and never pays Debt. Only the yield it earns is put to work.
      </p>
      <DataTable
        head={["Chain", "Token", "Yearly rate", "Where the Principal sits"]}
        rows={[
          ["Solana", "simSOL", "7%", "In a vault controlled by Tesoro's ledger program"],
          ["Ethereum", "simETH", "5%", "In a vault on Ethereum; the ledger stays on Solana"],
          ["HyperEVM", "simHYPE", "5%", "In a vault on HyperEVM; the ledger stays on Solana"],
        ]}
        caption="Positions you can open"
      />
      <p>
        You can get each token from your Wallet. Yield runs on a fast clock: a month of yield arrives in about 10 minutes.
      </p>

      <Shot name="wallet" url="playtesoro.com/wallet" alt="The Wallet showing a Position with its Debt, Horizon and Unlock Estimate" caption="The Wallet shows each Position, its Debt and its Unlock Estimate. Figures here are sample data." />

      <H2 id="advance">An Advance</H2>
      <p>
        An <b>Advance</b> is Gemas issued upfront against the projected yield of your Position over a <b>Horizon</b> of 1 to 12 months. It is 80% of
        that projected yield, the yield left after Tesoro&apos;s 20% Yield Fee:
      </p>
      <p>
        <b>Advance = Principal × yearly rate × months ÷ 12 × 80%</b>, converted to dollars once at the issuance price and rounded down to whole Gemas at
        $0.01 each.
      </p>
      <p>
        Your Position earns that same 80%, so the Advance is repaid in the Horizon you picked. The Yield Fee is taken from yield only, never from the
        Principal.
      </p>
      <p>A Position holds at most one open Advance. You can take a new one when its Debt is back to zero.</p>

      <H3 id="debt">Debt</H3>
      <p>
        The Gemas an Advance issues become the Position&apos;s <b>Debt</b>, fixed in the Position&apos;s own asset. Debt goes down in only two ways:
      </p>
      <ul>
        <li>
          <b>The Position&apos;s own yield.</b> All the yield it keeps (80% of what it earns) goes to the Debt first, automatically. There is no repay button and no way to skip it.
        </li>
        <li>
          <b>Returning your own unspent Gemas</b> from your Wallet, up to the Debt.
        </li>
      </ul>
      <p>
        Principal never pays Debt, and sending tokens straight into a Position&apos;s vault does not count as yield either.
      </p>

      <H3 id="unlock-estimate">Unlock Estimate</H3>
      <p>
        The <b>Unlock Estimate</b> is the projected date your Debt reaches zero. It is an estimate, never a promise: it moves with the yield the
        Position actually earns. If yield slows, the lock lasts longer.
      </p>

      <H2 id="unlock">Getting the Principal back</H2>
      <p>
        When the Debt is zero you can <b>Unlock</b> the Position and the Principal is released to you. On a Solana Position, yield beyond what the
        Advance needed comes back to you at Unlock; on Ethereum and HyperEVM Positions in this test version, that extra yield stays in the vault and
        is not paid out. Winning Gemas in Matches never shortens your own lock: your Debt is repaid by your Position&apos;s yield or by returning your own Gemas,
        and nothing else.
      </p>
      <p>
        If other Players hold Gemas won from your Position&apos;s Advance and have not yet redeemed them, the yield they are owed stays reserved in
        the Position&apos;s vault until they do.
      </p>

      <Callout kind="warn" title="What to keep in mind">
        <p>
          The Principal is locked until the Debt is repaid, and the staking token behind it carries its own price and protocol risk. Tesoro does not
          make a Position risk-free. <Link href="/docs/risks">Risks and limits</Link> lists what can go wrong.
        </p>
      </Callout>
    </DocPage>
  );
}
