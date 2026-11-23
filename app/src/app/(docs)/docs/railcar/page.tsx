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
  chanceRows,
  crashOdds,
  payoutRows,
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
  const pastMinute = Math.round(odds.pastMinuteOneIn / 10) * 10;
  return (
    <DocPage href="/docs/railcar">
      <H2 id="ride">A ride</H2>
      <p>
        Railcar is a Game for {MIN_PLAYERS} to {MAX_PLAYERS} Players. Everyone pays the same <b>entry of {g(ENTRY_GEMAS)} Gemas</b> and boards one car with a <b>Bomb</b> hidden
        inside it. Nobody knows when it goes off. Each Player chooses when to <b>Jump</b>. The last three Players off before the Bomb goes off (<b>Impact</b>) get their entry back
        and share the rest of the <b>Prize</b>. Everyone else gets nothing: a Player who Jumps earlier loses their entry, the same as a Player still aboard at Impact. What you
        Lock is never at stake, only your entry.
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
        <li>Starting a Break or Self-Exclusion while your car is still boarding steps you off it at once, with your full entry back.</li>
      </ul>

      <H2 id="prize">The Prize</H2>
      <p>
        The <b>Prize</b> is what the last three Players off share: every entry, less the fees. It is fixed when the car leaves and shown on the car for the whole ride. With{" "}
        {MIN_PLAYERS} Players at {g(ENTRY_GEMAS)} the Pot is {g(w.pot)}, fees are {g(w.fees)} and the Prize is {g(w.prize)}.
      </p>
      <p>
        Each Player who Jumps drops their entry onto the pile beside the Prize. The pile shows whose entries are already out of the car; it never adds to the Prize, which stays
        the number you saw when the car left. If nobody Jumps there is no Prize: every entry goes back and no fees are taken.
      </p>

      <H2 id="crash-point">The Crash point</H2>
      <p>
        The <b>Crash point</b> is where the Bomb goes off. It is drawn at random when the car leaves, and nobody can know it during the ride: not Players, not {BRAND.name}, not
        an outsider watching. The Bomb is never shown. The Crash point is published when the ride ends so anyone can check it: every finished ride&apos;s page (from your
        Matches) shows the crash point, each Tell&apos;s lead, every Brake and the draw, and replays the ride with these rules against what was paid: every place, every amount
        and, on a Backed seat, the Backer&apos;s and the Player&apos;s parts.
      </p>
      <p>The odds, measured at full speed, are published:</p>
      <ul>
        <li>There is no Bomb in the first {odds.safeSeconds} seconds.</li>
        <li>After that the chance that it goes off in the next second rises steadily with every second the car has run:</li>
      </ul>
      <DataTable head={["Car running for", "Chance it goes off in the next second"]} rows={chanceRows()} />
      <ul>
        <li>Half of all rides are over by {odds.medianSeconds} seconds, and 9 in 10 by {odds.nineInTenSeconds} seconds.</li>
        <li>About 1 ride in {pastMinute} passes a minute, and none passes {odds.certainSeconds / 60} minutes.</li>
        <li>The clock alone does not tell you when the Bomb goes off. The Tells are the warnings.</li>
      </ul>

      <H2 id="tells">Tells</H2>
      <p>
        The car warns you as the Bomb nears, with up to three Tells shown on the car itself. The first Tell shows on every ride. The other two each show on some rides only, and
        a Tell that does not show is never announced: after any Tell, the Bomb can go off with no further warning. A Tell that shows starts a random time before the Bomb,
        inside its published range.
      </p>
      <DataTable head={["Tell", "You hear", "Shows on", "Starts before the Bomb"]} rows={tells.map((t) => [t.name, t.sound, t.shows, t.range])} />
      <ul>
        <li>When the White-hot Tell shows, it comes at least {tellFacts.sparksFloorSeconds} seconds ahead.</li>
        <li>On {tellFacts.screwsOnly} the Glow is the only Tell.</li>
        <li>A few false Glows show early in a ride. They look and sound exactly like the real one, so counting them alone does not work.</li>
        <li>A ride that is shorter than a Tell&apos;s range starts that Tell when the car leaves.</li>
      </ul>

      <H2 id="jump">Jump</H2>
      <p>
        You can Jump at any moment while aboard. Jumps are ordered as the game receives them, so two Jumps never share a place. A Jump that arrives after Impact counts as still
        aboard, so nobody Jumps after seeing the blast. There is no automatic Jump: if your connection drops, you stay aboard, and the same rule holds for everyone.
      </p>
      <p>
        Only the last three Jumps are paid. Jump before them and you get nothing back: your entry stays on the pile, exactly as if you had stayed aboard. After you Jump, the
        screen shows your place so far, and how many have Jumped after you.
      </p>

      <H2 id="brake">Brake</H2>
      <p>
        Each Player has one Brake per ride, usable only while aboard. It halves the car&apos;s speed for {odds.brakeSeconds} seconds, which buys time once a Tell says the Bomb is
        close. The Brake is secret: the car slows for everyone, but only that Player sees it. Nobody sees speed or distance on their screen.
      </p>
      <ul>
        <li>A Brake pressed during another adds {odds.brakeSeconds} seconds more at half speed. Brakes extend each other; the car is never slower than half speed.</li>
        <li>The Crash point and the Tells stay at the same places on the track. A Brake changes when they arrive, not where.</li>
        <li>No ride lasts more than 10 minutes.</li>
        <li>When the ride ends, every Brake is published with the Crash point.</li>
      </ul>

      <H2 id="payout">Who is paid</H2>
      <p>
        Fees are 6% of the Pot: a Platform Fee of 2%, a Studio Fee of 3% and a Leaderboard Fee of 1%, all out of the entries of Players who lost them. Each of the last three
        Players off gets their entry back first, so a paid place never ends below its entry. What is left of the Prize is split by who left last:
      </p>
      <DataTable head={["Players who Jumped", "Split of what is left (last off first)"]} rows={payoutRows()} />
      <p>
        If nobody Jumps, every entry is refunded and no fees are taken. Winnings are the losers&apos; own Gemas, so they{" "}
        <Link href="/docs/gemas">Redeem like any other winnings</Link>. Only the last Player off earns Points; second and third place are paid without Points. For the limit of
        3 counted wins against the same opponent, the win counts against the second-last Player off, or, when only one Player Jumped, against the earliest other Player to
        board.
      </p>

      <H2 id="example">A worked example</H2>
      <p>
        Ana, Ben, Cy, Dee and Eve each enter {g(w.entry)}. The Pot is {g(w.pot)}, fees are 6% of it ({g(w.fees)}), and the car leaves with a Prize of {g(w.prize)}. Ana Jumps
        at 8 seconds: her {g(w.entry)} drops onto the pile and she gets nothing back.
      </p>
      <p>
        Cy, then Ben, then Dee Jump between 27 and 29 seconds. Eve is still aboard at Impact. Dee, Ben and Cy each get {g(w.entry)} back, {g(w.entry * 3n)} in all. What is left
        of the Prize is {g(w.rest)}, split 60% / 25% / 15%, and the Gema left over by rounding goes to the last off.
      </p>
      <DataTable
        head={["Player", "Result", "Gemas back"]}
        rows={[
          ["Dee", "Last off", g(p.Dee)],
          ["Ben", "Second-last off", g(p.Ben)],
          ["Cy", "Third-last off", g(p.Cy)],
          ["Ana", "Jumped early", g(p.Ana)],
          ["Eve", "Aboard at the blast", g(p.Eve)],
        ]}
      />
      <p>
        Fees {g(w.fees)}, and the total is {g(w.pot)}. Had Ana held on and been aboard at Impact too, every number would be the same.
      </p>

      <H2 id="outages">If the network stops</H2>
      <p>
        If the network that runs the ride slows to under half its normal speed for {odds.brakeSeconds} seconds, the ride is void: every entry is refunded in full and no fees are taken.
        If every Player&apos;s page is closed, the ride still ends and pays on its own.
      </p>

      <H2 id="backing">Backing</H2>
      <p>
        Railcar can be <Link href="/docs/backing">Backed</Link>. A Backer gets their entry back first on a paid place, then the rest is split by the Offer. If the Player Jumps
        early or is still aboard at Impact, the Backer loses the entry and no more. A Backer funds at most one seat per car.
      </p>

      <H2 id="practice">Practice</H2>
      <p>
        Practice rides the same car with 9 simulated riders, on the same odds, Tells and Brake. It runs on your device: no sign-in, nothing staked, nothing sent. The car leaves
        at once, and the Result shows what an entry of {g(ENTRY_GEMAS)} Gemas would have paid.
      </p>
    </DocPage>
  );
}
