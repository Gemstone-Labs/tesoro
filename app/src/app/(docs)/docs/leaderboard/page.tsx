import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";

export const metadata: Metadata = { title: "Leaderboard", alternates: { canonical: "/docs/leaderboard" } };

export default function Page() {
  return (
    <DocPage href="/docs/leaderboard">
      {/* TODO(verify-after-merge): whole page is written from the Oct 10 spec: weekly seasons, 1% Leaderboard Fee into the Leaderboard Pool, points 5 / 10 / 25 for wins at 500 / 1,000 / 2,500, top 10 split 25 / 18 / 13 / 10 / 8 / 7 / 6 / 5 / 4 / 4%, unpaid shares roll over. Page lives at /leaderboard. */}
      <p>
        The Leaderboard rewards Players who win Matches. Every Match in every Game adds a little to a shared prize pool, and each week the top ten
        Players split it.
      </p>

      <H2 id="pool">The Leaderboard Pool</H2>
      <p>
        Every Match in every Game pays a <b>Leaderboard Fee of 1%</b> of the Pot into the <b>Leaderboard Pool</b>. It is charged on top of the
        Platform Fee and the Studio Fee (see <Link href="/docs/fees">Fees</Link>). Draws and refunds take no Fees, so they add nothing to the Pool.
      </p>

      <H2 id="seasons">Seasons</H2>
      <p>
        The Leaderboard runs in <b>weekly seasons</b>. Points count within a season, and each season starts again from zero.
      </p>

      <H2 id="points">How you earn points</H2>
      <p>You earn points when you <b>win</b> a Match, scaled by its entry:</p>
      <DataTable
        head={["Entry", "Points for a win"]}
        rows={[
          ["500 Gemas", "5"],
          ["1,000 Gemas", "10"],
          ["2,500 Gemas", "25"],
        ]}
      />
      <p>Losses, draws and refunds earn nothing. The game does not matter: a win in Block Puzzle, Hold&apos;em or Trading Duel counts the same at the same entry.</p>

      <H2 id="prizes">Who gets paid</H2>
      <p>At the end of the season, the <b>top 10</b> Players by points split the Pool:</p>
      <DataTable
        head={["Rank", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]}
        rows={[["Share of the Pool", "25%", "18%", "13%", "10%", "8%", "7%", "6%", "5%", "4%", "4%"]]}
      />
      <p>
        If fewer than ten Players earned points, the shares nobody earned <b>roll into the next season&apos;s Pool</b>.
      </p>

      <H2 id="where">Where to see it</H2>
      <p>
        The live standings, the current Pool and the time left in the season are on the <Link href="/leaderboard">Leaderboard page</Link> in the app. It
        is public, and you can read it without signing in.
      </p>

      <Callout kind="note" title="Test mode">
        <p>The Pool is made of test Gemas. Nothing in it has real value yet.</p>
      </Callout>
    </DocPage>
  );
}
