import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";

export const metadata: Metadata = { title: "Private Ephemeral Rollups", alternates: { canonical: "/docs/developers/rollups" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/rollups">
      <p>
        A Match&apos;s result must reach the Solana settlement program without trusting a Studio server&apos;s signature, and some of its state must stay hidden:
        the Hold&apos;em deck, a Player&apos;s hole cards, a Block Puzzle run, a Trading Duel position. ADR 0003 decides that each Game is a Solana program whose
        Match state is delegated to a <b>MagicBlock Private Ephemeral Rollup</b>, which runs in an Intel TDX trusted execution environment (TEE).
      </p>

      <H2 id="lifecycle">Lifecycle of delegated state</H2>
      <ol>
        <li><b>Base layer.</b> Players open and join the Match in tesoro_core. The Game creates its state accounts (Session and Boards, or a table, or a Duel).</li>
        <li><b>Delegate.</b> The Game&apos;s state accounts are delegated to the TEE validator. Anyone may send the delegation transaction.</li>
        <li><b>Permissions.</b> Permission accounts declare who can read each delegated account. Inside the rollup, an account with a permission is unreadable to non-members.</li>
        <li><b>Play.</b> Game instructions run in the rollup against the delegated accounts, with the Game&apos;s own clocks and rules.</li>
        <li><b>Commit and undelegate.</b> Hidden state is wiped, permissions are closed, and the final state is committed back to the base layer.</li>
        <li><b>Settle.</b> On the base layer, anyone calls the Game&apos;s settle instruction, which CPIs into tesoro_core (see <Link href="/docs/developers/settlement">How settlement works</Link>).</li>
      </ol>
      <p>
        Rollup (TEE) transactions are private and have no public explorer page. The Game&apos;s evidence files in the repository (<code>evidence.json</code>) record
        their signatures.
      </p>

      <H2 id="pinned-validator">Delegation is pinned to one validator</H2>
      <p>
        An early review found that anyone could delegate a Game&apos;s state to a validator they controlled and commit a forged result (audit F-01, Critical).
        The fix has two parts. The delegation program keeps a <code>ProgramConfig</code> per Game program whose <code>approved_validators</code> lists only the
        MagicBlock TEE validator, and the Game programs also pin the validator themselves. A delegation naming any other validator fails with{" "}
        <code>InvalidValidator</code> (custom error 6020). The ProgramConfig addresses are on <Link href="/docs/developers/programs">Programs and addresses</Link>.
      </p>

      <H2 id="by-game">What is hidden in each Game</H2>
      <DataTable
        head={["Game", "Hidden", "How it is hidden", "What becomes public"]}
        rows={[
          ["Block Puzzle", "The Seed, then each Player's Board (moves)", "A SeedVault with a permission that has zero members. The Seed is written there only by the VRF callback and copied into a Player's own Board by begin_run, in the transaction that starts their 90 s clock. Each Board's only member is its Player.", "After seal and commit: both Boards. The SeedVault is wiped."],
          ["Hold'em", "The Deck and each Player's hole cards", "Deck: zero-member permission. Hole accounts: readable by their Player. The seed of a hand folds both Players' fresh secrets and the VRF output.", "Board cards as dealt; hole cards only at a showdown. close_match wipes the Deck and Holes before committing."],
          ["Trading Duel", "Each Player's Book: open position and fills", "Book readable only by its Player. The public Duel carries a coarse lead and the trade counts.", "After the Match is committed: both full fill histories."],
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
        No Block Puzzle instruction takes a score. <code>play</code> feeds each <code>(piece, x, y)</code> to the deterministic engine on the Board&apos;s own state,
        illegal moves revert the batch, and the packed move log is stored so anyone can re-verify. A bit-exact TypeScript port of the engine
        (<code>app/src/games/block-puzzle/engine.ts</code>) lets the app preview the same result.
      </p>

      <H3 id="trading-duel">Trading Duel prices</H3>
      <p>
        Fills execute at MagicBlock&apos;s real-time pricing oracle (Pyth Lazer pushed into rollup accounts every 50 to 200 ms). The program reads the Pyth
        <code>PriceUpdateV2</code> bytes itself. Anti-latency rules: a 5 bps spread on every fill and rejection of any price older than 2 seconds. The end price is
        pinned: <code>end_match</code> needs a price published within <code>[ends_at, ends_at + 4 s]</code>, otherwise it settles at the last mid recorded during the window,
        so waiting cannot change the result. Maintenance margin is 50 bps and a liquidated position loses at most its margin.
      </p>

      <H2 id="liveness">Liveness</H2>
      <p>
        Clocks live in the programs: Block Puzzle 90 s per run, an opener window of one hour and a joiner window of 24 hours; Hold&apos;em 30 s per action and 60 s
        to contribute entropy, with three missed turns in a row a forfeit; Trading Duel a five-minute window. <code>claim_timeout</code>, <code>seal</code>,{" "}
        <code>commit_boards</code>, <code>finalize</code> and <code>settle</code> can be sent by anyone, and the keeper sends them when no Player does.
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
