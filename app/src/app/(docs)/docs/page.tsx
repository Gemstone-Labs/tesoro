import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocPage, H2, Sim } from "@/components/docs/prose";
import { ALL_PAGES } from "@/components/docs/nav";

export const metadata: Metadata = { title: "Overview", alternates: { canonical: "/docs" } };

const START = ["/docs/how-it-works", "/docs/positions", "/docs/matches", "/docs/backing"];
const DEV = ["/docs/developers", "/docs/developers/programs", "/docs/developers/settlement", "/docs/developers/run"];

function Cards({ hrefs }: { hrefs: string[] }) {
  return (
    <ul className="docs-cards">
      {hrefs.map((h) => {
        const p = ALL_PAGES.find((x) => x.href === h)!;
        return (
          <li key={h}>
            <Link href={h} className="docs-card cut cut-card">
              <b>{p.title}</b>
              <span>{p.summary}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function Page() {
  return (
    <DocPage href="/docs">
      <p>
        Tesoro lets people who stake crypto <b>play now with yield they have not earned yet</b>. You lock a staking token as a Position, Tesoro
        advances its projected yield as Gemas, and you spend those Gemas on head-to-head skill games. Your staked amount, the Principal, is never
        played.
      </p>
      <Callout kind="sim" title="Test mode">
        <p>
          Tesoro runs on test networks today. The staking tokens are <Sim /> and earn a month of yield in about 10 minutes, so you can see the whole
          loop in an afternoon. Nothing on these pages has real value. See <Link href="/docs/risks">Risks and limits</Link> for the full list.
        </p>
      </Callout>

      <H2 id="the-idea">The idea in four lines</H2>
      <ul>
        <li>
          <b>Position.</b> You lock a staking token. Its Principal stays locked and is never entered into a Match.
        </li>
        <li>
          <b>Advance.</b> You choose a Horizon of 1 to 12 months and receive 100% of the Position&apos;s projected yield over it, upfront, as Gemas.
        </li>
        <li>
          <b>Match.</b> You enter Gemas in a head-to-head game. The winner takes the Pot minus Fees.
        </li>
        <li>
          <b>Pay back from yield.</b> The Position&apos;s own yield repays the Advance automatically. When the Debt reaches zero, you can unlock the
          Position and take your Principal back.
        </li>
      </ul>
      <p>
        What you can lose in a Match is the Gemas you enter; the Principal is never entered. The trade-off is time: the Position stays locked until
        the Advance is repaid, and the staking token keeps its own market risk.
      </p>

      <H2 id="start-here">Start here</H2>
      <Cards hrefs={START} />

      <H2 id="all-pages">Everything on one map</H2>
      <p>
        <b>For players:</b> <Link href="/docs/accounts">Accounts and sign-in</Link>, <Link href="/docs/gemas">Gemas</Link>,{" "}
        <Link href="/docs/leaderboard">Leaderboard</Link>, <Link href="/docs/fees">Fees</Link>, <Link href="/docs/chains">Chains</Link>,{" "}
        <Link href="/docs/fairness">Fairness and privacy</Link> and <Link href="/docs/risks">Risks and limits</Link>.
      </p>
      <p>
        Stuck on something in the app? The <Link href="/help">Help page</Link> answers common questions in short form.
      </p>

      <H2 id="for-developers">For developers and judges</H2>
      <p>
        The developer pages name the plumbing: program IDs you can check on an explorer, how a Game settles a Pot, how hidden information works in
        MagicBlock Private Ephemeral Rollups, how LayerZero V2 carries Positions from Ethereum and HyperEVM to the Solana ledger, and what the
        security review found.
      </p>
      <Cards hrefs={DEV} />
    </DocPage>
  );
}
