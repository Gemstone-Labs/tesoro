import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable, DocPage, H2 } from "@/components/docs/prose";
import { BRAND } from "@/lib/brand";
import { fmtGemas } from "@/lib/format";
import {
  COUNTDOWN_SECONDS,
  ENTRY_GEMAS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  crashOdds,
  payoutRows,
  refundRows,
  tellOdds,
  tellRows,
  workedExample,
} from "@/games/railcar/rules";
import { RAILCAR_SHOWN } from "@/lib/games";

export const metadata: Metadata = { title: "Railcar", alternates: { canonical: "/docs/railcar" } };

const g = (n: bigint) => fmtGemas(Number(n));

export default function Page() {
  if (!RAILCAR_SHOWN) notFound();
  const odds = crashOdds();
  const tells = tellRows();
  const tellFacts = tellOdds();
  const w = workedExample();
  const p = w.payouts;
  return (
    <DocPage href="/docs/railcar">
      <H2 id="ride">A ride</H2>
      <p>
        Railcar is a Game for {MIN_PLAYERS} to {MAX_PLAYERS} Players. Everyone pays the same <b>entry of {g(ENTRY_GEMAS)} Gemas</b> and boards one car. The car runs toward a wall
        at a distance nobody knows. Each Player chooses when to <b>Jump</b>. The last three Players off before <b>Impact</b> get their entry back and share the rest of the Pot.
        Players still aboard at Impact lose their entry, and nothing else: what you Lock is never at stake.
      </p>
      <p>
        <Link href="/play/railcar">Play Railcar</Link> or try it first with <Link href="/play/practice?game=railcar">Practice free</Link>.
      </p>

      <H2 id="boarding">Boarding</H2>
      <ul>
        <li>One Queue, one entry. You board the car that is boarding now.</li>
        <li>The car waits, with no time limit, until {MIN_PLAYERS} Players have boarded. The {COUNTDOWN_SECONDS} second countdown starts when the {MIN_PLAYERS}th boards, and anyone can still board until it ends.</li>
        <li>A car with {MAX_PLAYERS} Players leaves at once. The next Player boards the next car.</li>
        <li>You can step off any time before the car leaves and get your full entry back. The departure time is fixed when the {MIN_PLAYERS}th Player first boards and never restarts. If stepping off leaves fewer than {MIN_PLAYERS} aboard at that time, the car waits and leaves the moment another Player boards.</li>
        <li>You hold one seat per car. A Player on a Break or under Self-Exclusion cannot board, and boarding counts against an Entry Limit.</li>
      </ul>

      <H2 id="crash-point">The Crash point</H2>
      <p>
        The <b>Crash point</b> is where the wall stands. It is drawn at random when the car leaves, and nobody can know it during the ride: not Players, not {BRAND.name}, not an
        outsider watching. It is published when the ride ends so anyone can check it: every finished ride&apos;s page (from your Matches) shows the crash point, each
        Tell&apos;s lead, every Brake and the draw, and replays the ride with these rules against what was paid.
      </p>
      <p>The odds, measured at full speed, are published:</p>
      <ul>
        <li>There is no crash in the first {odds.safeSeconds} seconds.</li>
        <li>After that there is an even chance every second, so the clock alone tells you nothing about how close the wall is.</li>
        <li>Half of all rides are over by {odds.medianSeconds} seconds.</li>
        <li>The wall is certain by {odds.certainSeconds / 60} minutes.</li>
      </ul>

      <H2 id="tells">Tells</H2>
      <p>
        The car warns you as the wall nears, with up to three Tells. The screws show on every ride. The panel and the sparks each show on some rides only, and a Tell that
        does not show is never announced: after any Tell, the wall can come with no further warning. A Tell that shows starts a random distance before the wall, inside its
        published range.
      </p>
      <DataTable
        head={["Tell", "Shows on", "Starts before the wall"]}
        rows={tells.map((t) => [t.name, t.shows, t.range])}
      />
      <ul>
        <li>When the sparks show, they come at least {tellFacts.sparksFloorSeconds} seconds ahead.</li>
        <li>On {tellFacts.screwsOnly} the screws are the only Tell.</li>
        <li>A few false screws show early in a ride. They look and sound exactly like the real ones, so counting screws alone does not work.</li>
        <li>A ride that is shorter than a Tell&apos;s range starts that Tell when the car leaves.</li>
      </ul>

      <H2 id="jump">Jump and the Early-jump refund</H2>
      <p>
        You can Jump at any moment while aboard. Jumps are ordered as the game receives them, so there are no ties. A Jump that arrives after Impact counts as still aboard, so
        nobody Jumps after seeing the crash. There is no automatic Jump: if your connection drops, you stay aboard, and the same rule holds for everyone.
      </p>
      <p>
        Jump before the last three and you get an <b>Early-jump refund</b>: part of your entry back, free of fees. It falls the longer the car has travelled. It is
        measured in distance, not in time, so a Brake never lowers it.
      </p>
      <DataTable head={["Distance travelled", "Refund"]} rows={refundRows()} />

      <H2 id="brake">Brake</H2>
      <p>
        Each Player has one Brake per ride, usable only while aboard. It halves the car&apos;s speed for {odds.brakeSeconds} seconds, which buys time once a Tell says the wall is close. The Brake is secret:
        the car slows for everyone, but only that Player sees it. Nobody sees speed, distance or a live refund on their screen.
      </p>
      <ul>
        <li>A Brake pressed during another adds {odds.brakeSeconds} seconds more at half speed. Brakes extend each other; the car is never slower than half speed.</li>
        <li>The wall, the Tells and the refund steps stay at the same places on the track. A Brake changes when they arrive, not where.</li>
        <li>No ride lasts more than 10 minutes.</li>
        <li>When the ride ends, every Brake is published with the Crash point.</li>
      </ul>

      <H2 id="payout">Who is paid</H2>
      <p>
        Fees come off the Pot after Early-jump refunds: a Platform Fee of 2%, a Studio Fee of 3% and a Leaderboard Fee of 1%, all out of the Gemas of Players who lost their entry.
        Each of the last three Players off gets their entry back first, so a paid place never ends below its entry. What is left is split by who left last:
      </p>
      <DataTable head={["Players who Jumped", "Split of what is left (last off first)"]} rows={payoutRows()} />
      <p>
        If nobody Jumps, every entry is refunded and no fees are taken. Winnings are the losers&apos; own Gemas, so they{" "}
        <Link href="/docs/gemas">Redeem like any other winnings</Link>. Only the last Player off earns Points; second and third place are paid without Points.
      </p>

      <H2 id="example">A worked example</H2>
      <p>
        Ana, Ben, Cy, Dee and Eve each enter {g(w.entry)}. The Pot is {g(w.pot)}. Ana Jumps at 25 seconds and gets an Early-jump refund of 70%: {g(w.anaRefund)} back, free of fees. The Pot after
        refunds is {g(w.potAfterRefunds)}, and fees are 6% of it: {g(w.fees)}.
      </p>
      <p>
        Cy, then Ben, then Dee Jump between 95 and 100 seconds. Eve is still aboard at Impact. Dee, Ben and Cy each get {g(w.entry)} back, {g(w.entry * 3n)} in all. What is left is{" "}
        {g(w.rest)}, split 60% / 25% / 15%.
      </p>
      <DataTable
        head={["Player", "Result", "Gemas back"]}
        rows={[
          ["Dee", "Last off", g(p.Dee)],
          ["Ben", "Second-last off", g(p.Ben)],
          ["Cy", "Third-last off", g(p.Cy)],
          ["Ana", "Early-jump refund", g(p.Ana)],
          ["Eve", "Aboard at Impact", g(p.Eve)],
        ]}
      />
      <p>Fees {g(w.fees)}, and the total is {g(w.pot)}.</p>

      <H2 id="outages">If the network stops</H2>
      <p>
        If the network that runs the ride slows to under half its normal speed for {odds.brakeSeconds} seconds, the ride is void: every entry is refunded in full and no fees are taken.
        If every Player&apos;s page is closed, the ride still ends and pays on its own.
      </p>

      <H2 id="backing">Backing</H2>
      <p>
        Railcar can be <Link href="/docs/backing">Backed</Link>. An Early-jump refund goes to the Backer. A Backer gets their entry back first on a paid place, then the rest is split
        by the Offer. If the Player is still aboard at Impact, the Backer loses the entry and no more. A Backer funds at most one seat per car.
      </p>

      <H2 id="practice">Practice</H2>
      <p>
        Practice rides the same car with 9 simulated riders, on the same odds, Tells, Brake and refunds. It runs on your device: no sign-in, nothing staked, nothing
        sent. The car leaves at once, and the Result shows what an entry of {g(ENTRY_GEMAS)} Gemas would have paid.
      </p>
    </DocPage>
  );
}
