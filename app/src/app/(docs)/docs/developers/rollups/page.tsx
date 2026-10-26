import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { Cpu, GitCommitHorizontal, KeyRound, Landmark, Play, Send } from "lucide-react";
import { Pipeline } from "@/components/docs/visual";
import { isHiddenGame } from "@/lib/games";

export const metadata: Metadata = { title: "Private Ephemeral Rollups", alternates: { canonical: "/docs/developers/rollups" } };

export default function Page() {
  const vg = !isHiddenGame("vanguard");
  return (
    <DocPage href="/docs/developers/rollups" hero={<Pipeline label="Life of a Match on a table" items={[
  { icon: Landmark, tone: "sapphire", title: "Base layer", body: "Match opens in tesoro_core." },
  { icon: Send, tone: "violet", title: "Assign", body: "An idle table takes the Match." },
  { icon: KeyRound, tone: "violet", title: "Seats", body: "Only the two Players read them." },
  { icon: Play, tone: "amber", title: "Play", body: "Game rules run in the rollup." },
  { icon: GitCommitHorizontal, tone: "violet", title: "Commit", body: "The result goes back to base." },
  { icon: Cpu, tone: "emerald", title: "Finalize", body: "CPI into tesoro_core." },
]} />}>
      <p>
        A Match&apos;s result must reach the Solana settlement program without trusting a Studio server&apos;s signature, and some of its state must stay hidden:
        a Player&apos;s hole cards, a Block Burst run, a Trading Duel pick{vg ? ", a Vanguard army" : ""}. ADR 0003 decides that each Game is a Solana program whose
        tables are delegated to a <b>MagicBlock Private Ephemeral Rollup</b>, which runs in an Intel TDX trusted execution environment (TEE).
      </p>

      <H2 id="lifecycle">Tables and the life of a Match</H2>
      <p>
        A Game does not delegate a new set of accounts for every Match. It keeps a fixed set of <b>tables</b>: each is a program account delegated to the TEE validator
        once and left there, so a Match costs a few cheap rollup transactions instead of a delegation. A table stays delegated across Matches and does not undelegate in normal running.
      </p>
      <ol>
        <li><b>Base layer.</b> Players open and join the Match in tesoro_core.</li>
        <li><b>Assign.</b> The Game&apos;s operator key writes one <code>Assignment</code> naming an idle table and its current epoch. It can name only the table: the two Players and the asset are read from the Match in tesoro_core, and the start deadline comes from the program&apos;s clock. A table takes one Match per epoch, and the epoch moves on at every reset.</li>
        <li><b>Seats.</b> A Game with hidden information keeps private seat accounts on the table (rollup-only accounts behind a private permission). Between Matches a seat is wiped and then given to the next two Players, so it is never without a permission.</li>
        <li><b>Check in and play.</b> <code>begin_match</code> reserves one of the table&apos;s result slots; the Match starts when both Players have checked in (a Player who does not loses, and if neither does, each side pays the Platform Fee). Game rules and clocks run in the rollup.</li>
        <li><b>Result and commit.</b> The end of the Match writes the outcome into its slot in the table&apos;s result ring. The table is then <i>dirty</i>, and exactly one commit sends it back to the base layer. A Sponsor account on the rollup pays the commit, so Players never pay for it and nobody can drain it with extra commits.</li>
        <li><b>Finalize.</b> On the base layer anyone calls the Game&apos;s <code>finalize</code>, which reads only the committed table&apos;s result ring and CPIs into tesoro_core (see <Link href="/docs/developers/settlement">How settlement works</Link>). A slot is freed once tesoro_core has written the settlement receipt, and the table is reset for the next epoch.</li>
      </ol>
      <p>
        If a result never reaches the base layer, the Match is not lost: tesoro_core refunds it at its own deadline, and a table that moved past a Match without ever running it lets the Match refund at once.
        Rollup (TEE) transactions are private and have no public explorer page. The Game&apos;s evidence files in the repository (<code>evidence.json</code>) record
        their signatures.
      </p>

      <H2 id="pinned-validator">Delegation is pinned to one validator</H2>
      <p>
        If anyone could delegate a Game&apos;s state to a validator they controlled, they could commit a forged result. Two checks prevent it. The delegation program keeps a <code>ProgramConfig</code> per Game program whose <code>approved_validators</code> lists only the
        MagicBlock TEE validator, and the Game programs also pin the validator themselves. A delegation naming any other validator fails with{" "}
        <code>InvalidValidator</code> (custom error 6020). The ProgramConfig addresses are on <Link href="/docs/developers/programs">Programs and addresses</Link>.
      </p>

      <H2 id="by-game">What is hidden in each Game</H2>
      <DataTable
        head={["Game", "Hidden", "How it is hidden", "What becomes public"]}
        rows={[
          ["Block Burst", "The Seed, then each Player's Board (moves), and the opponent's score for the last 10 seconds", "The Seed is written by the VRF callback into a vault seat with no members and copied into a Player's own Board by begin, in the transaction that starts that Player's clock. Each Board's only member is its Player. From 80 s into the 90 s run, moves go through play_hidden, which writes no public score and is sent on a fixed beat (one transaction every 0.6 s whether or not the Player moved), so the opponent cannot tell when a move was made.", "At the end of the Match: the Seed, both move logs and their timing, in the table's result ring."],
          ["Hold'em", "Each Player's hole cards", "Hole accounts are seats readable only by their Player. There is no stored deck: cards are drawn from a seed that folds the VRF output with both Players' fresh secrets, which sit in seats and are never an instruction argument.", "Board cards as dealt; hole cards only at a showdown. The seats are wiped before the table is committed."],
          ["Trading Duel", "Each Player's Book: picks for columns that have not locked", "Each Book is a seat readable only by its Player. When a column locks, both picks for it are copied into the public table.", "As columns lock: both picks. After the Match: both full Books."],
          ...(vg ? [["Vanguard", "Both armies and each Player's secret", "Each army is a seat readable only by its Player; the setup uses both Players' secrets and the VRF output.", "The board as it is played, and every piece left standing at the end."]] : []),
        ]}
      />

      <H3 id="randomness">Randomness</H3>
      <p>
        Randomness comes from MagicBlock&apos;s VRF, delivered by callback straight into private state inside the TEE, so a public VRF value cannot expose it.
        Hold&apos;em additionally folds both Players&apos; own per-hand secrets (<code>contribute_entropy</code>) into the seed: <code>seed = H(entropy || vrf ||
        hand_no)</code>.
      </p>

      <H3 id="score-is-replay">Score is a replay, never reported</H3>
      <p>
        No Block Burst instruction takes a score. <code>play</code> feeds each <code>(piece, x, y)</code> to the deterministic engine on the Board&apos;s own state,
        illegal moves revert the batch, and the packed move log is stored so anyone can re-verify. A bit-exact TypeScript port of the engine
        (<code>app/src/games/block-puzzle/engine.ts</code>) lets the app preview the same result.
      </p>

      <H3 id="trading-duel">Trading Duel prices</H3>
      <p>
        The line is sampled from MagicBlock&apos;s real-time pricing oracle (Pyth Lazer pushed into rollup accounts every 50 to 200 ms). The program reads the Pyth
        <code>PriceUpdateV2</code> bytes itself, refuses any price older than 2 seconds, and records each sample into the current column&apos;s low and high.
        Anyone may call <code>tick</code> to add samples, but a sample is always a real price. The bands are fixed from the start price (band 0 begins there, and any band, above or below, can be picked), and a column locks 10 seconds
        before its window, so a faster feed cannot help a pick. The Match ends without an end price: <code>end_match</code> carries the last recorded price through
        any column the line did not reach, so the result is the same whoever ends it and when.
      </p>

      <H2 id="liveness">Liveness</H2>
      <p>
        Clocks live in the programs: every Game gives a paired Player 60 s to check in or take the first step. Block Burst 60 s to check in, 60 s for the pieces, a 10 s countdown, a 90 s run and 3 s of grace; Hold&apos;em 30 s per action and 60 s
        to contribute entropy, with three missed turns in a row a forfeit; Trading Duel a two-and-a-half-minute grid{vg ? "; Vanguard 10 s per move, three missed turns in a row a forfeit, and a 15 minute limit on the whole Battle" : ""}. <code>claim_timeout</code>,{" "}
        <code>close</code>, <code>finalize</code> and <code>settle</code> can be sent by anyone, and the keeper sends them when no Player does.
      </p>

      <Callout kind="warn" title="What this does and does not buy">
        <p>
          &ldquo;Private with zero members&rdquo; means no external reader, not encryption: the program itself can read the state, and privacy depends on MagicBlock&apos;s
          TEE attestation and operator. A colluding operator or VRF oracle could in principle reveal a Seed or cards early. This is listed in{" "}
          <Link href="/docs/risks">Risks and limits</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
