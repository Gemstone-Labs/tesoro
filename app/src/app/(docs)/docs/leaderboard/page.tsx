import type { Metadata } from "next";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { fmtGemas } from "@/lib/format";
import Link from "next/link";
import { DataTable, DocPage, H2 } from "@/components/docs/prose";
import { SeasonDiagram, Shot } from "@/components/docs/visual";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Leaderboard", alternates: { canonical: "/docs/leaderboard" } };

export default function Page() {
  return (
    <DocPage href="/docs/leaderboard" hero={<Shot name="leaderboard" url={`${BRAND.domain}/leaderboard`} alt="The Leaderboard with the current Pool, time left in the season and the top Players" priority caption="The live Leaderboard: the Pool, the time left in the season and the standings." />}>
      <p>
        The Leaderboard rewards Players who win Matches. Every Match in every Game adds a little to a shared prize pool, and each week the top ten
        Players split it.
      </p>

      <H2 id="pool">The Leaderboard Pool</H2>
      <p>
        Every Match in every Game pays a <b>Leaderboard Fee of 1%</b> of the Pot into the <b>Leaderboard Pool</b>. It is charged on top of the
        Platform Fee and the Studio Fee (see <Link href="/docs/fees">Fees</Link>), taken from the loser&apos;s Gemas like the other two. Draws and refunds take no Fees, so they add nothing to the Pool.
      </p>

      <H2 id="seasons">Seasons</H2>
      <p>
        The Leaderboard runs in <b>weekly seasons</b>, from Monday 00:00 UTC to the next Monday. Season 1 began on 5 October 2026. Points count within a
        season, and each season starts again from zero.
      </p>

      <SeasonDiagram />

      <H2 id="points">How you earn points</H2>
      <p>You earn points when you <b>win</b> a Match, scaled by its entry:</p>
      <DataTable
        head={["Entry", "Points for a win"]}
        rows={ENTRY_SIZES.map((e) => [`${fmtGemas(e)} Gemas`, String(e / 100)])}
      />
      <p>Losses, draws and refunds earn nothing. The game does not matter: a win in Block Puzzle, Hold&apos;em or Trading Duel counts the same at the same entry.</p>
      <p>
        When a <Link href="/docs/backing">Backer</Link> funds the entry, the points go to the Player who played, not to the Backer. If two Players finish
        on the same points, the one who won first that week ranks higher. Only your first 3 wins against the same opponent in a season earn points;
        later wins against them still count as wins but add none.
      </p>

      <H2 id="prizes">Who gets paid</H2>
      <p>At the end of the season, the <b>top 10</b> Players by points split the Pool:</p>
      <DataTable
        head={["Rank", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]}
        rows={[["Share of the Pool", "25%", "18%", "13%", "10%", "8%", "7%", "6%", "5%", "4%", "4%"]]}
      />
      <p>
        If fewer than ten Players earned points, the shares nobody earned <b>roll into the next season&apos;s Pool</b>.
      </p>
      <p>
        Prizes are paid in Gemas, each keeping the Source it came from, shortly after the season ends. The ranking is recorded on chain before anything is
        paid.
      </p>

      <H2 id="where">Where to see it</H2>
      <p>
        The live standings, the current Pool and the time left in the season are on the <Link href="/leaderboard">Leaderboard page</Link> in the app. It
        is public, and you can read it without signing in.
      </p>
    </DocPage>
  );
}
