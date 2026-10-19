import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { DebtDiagram, Shot } from "@/components/docs/visual";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Locks and Advances", alternates: { canonical: "/docs/positions" } };

export default function Page() {
  return (
    <DocPage href="/docs/positions" hero={<DebtDiagram />}>
      <H2 id="position">A Lock</H2>
      <p>
        A <b>Lock</b> is your locked, yield-bearing token in {BRAND.name}. The amount inside it is the <b>Locked amount</b>. It is only
        ever locked: it is never entered into a Match, never spent, and never used to pay back an Advance. Only the yield it earns is put to work.
      </p>
      <DataTable
        head={["Chain", "Token", "Yearly rate", "Where your Locked amount sits"]}
        rows={[
          ["Solana", "test SOL", "7%", `In a vault controlled by ${BRAND.name}'s ledger program`],
          ["Ethereum", "test ETH", "5%", "In a vault on Ethereum; the ledger stays on Solana"],
          ["HyperEVM", "test HYPE", "5%", "In a vault on HyperEVM; the ledger stays on Solana"],
        ]}
        caption="Locks you can open"
      />
      <p>
        You can get each token from your Wallet. Yield runs on a fast clock: a month of yield arrives in about 10 minutes.
      </p>

      <Shot name="wallet" url={`${BRAND.domain}/wallet`} alt="The Wallet showing a Lock with what is left to pay back, its Length and Unlock Estimate" caption="The Wallet shows each Lock, what is left to pay back and its Unlock Estimate. Figures here are sample data." />

      <H2 id="advance">An Advance</H2>
      <p>
        An <b>Advance</b> is Gemas issued upfront against the projected yield of your Lock over a <b>Length</b> of 1 to 12 months. It is 80% of
        that projected yield, the yield left after {BRAND.name}&apos;s 20% Yield Fee:
      </p>
      <p>
        <b>Advance = Locked amount × yearly rate × months ÷ 12 × 80%</b>, converted to dollars once at the issuance price and rounded down to whole Gemas at
        $0.01 each.
      </p>
      <p>
        Your Lock earns that same 80%, so the Advance is repaid in the Length you picked. The Yield Fee is taken from yield only, never from the
        Locked amount.
      </p>
      <p>A Lock holds at most one open Advance. You can take a new one when nothing is left to pay back.</p>

      <H3 id="debt">Left to pay back</H3>
      <p>
        The Gemas an Advance issues become what is <b>left to pay back</b> on the Lock, fixed in the Lock&apos;s own coin. It goes down in only two ways:
      </p>
      <ul>
        <li>
          <b>The Lock&apos;s own yield.</b> All the yield it keeps (80% of what it earns) goes to paying it back first, automatically. There is no repay button and no way to skip it.
        </li>
        <li>
          <b>Returning your own unspent Gemas</b> from your Wallet, up to what is left to pay back.
        </li>
      </ul>
      <p>
        Your Locked amount never pays it back, and sending tokens straight into a Lock&apos;s vault does not count as yield either.
      </p>

      <H3 id="unlock-estimate">Unlock Estimate</H3>
      <p>
        The <b>Unlock Estimate</b> is the projected date nothing is left to pay back. It is an estimate, never a promise: it moves with the yield the
        Lock actually earns. If yield slows, the lock lasts longer.
      </p>

      <H2 id="unlock">Getting your coins back</H2>
      <p>
        When nothing is left to pay back you can <b>Unlock</b> the Lock and your coins are released to you. On a Solana Lock, yield beyond what the
        Advance needed comes back to you at Unlock; on Ethereum and HyperEVM Locks in this test version, that extra yield stays in the vault and
        is not paid out. Winning Gemas in Matches never shortens your own lock: the Advance is paid back by your Lock&apos;s yield or by returning your own Gemas,
        and nothing else.
      </p>
      <p>
        If other Players hold Gemas won from your Lock&apos;s Advance and have not yet redeemed them, the yield they are owed stays reserved in
        the Lock&apos;s vault until they do.
      </p>

      <Callout kind="warn" title="What to keep in mind">
        <p>
          What you lock stays locked until the Advance is paid back, and the staking token behind it carries its own price and protocol risk. {BRAND.name} does not
          make a Lock risk-free. <Link href="/docs/risks">Risks and limits</Link> lists what can go wrong.
        </p>
      </Callout>
    </DocPage>
  );
}
