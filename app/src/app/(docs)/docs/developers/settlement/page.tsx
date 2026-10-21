import type { Metadata } from "next";
import Link from "next/link";
import { Callout, Code, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { Sequence } from "@/components/docs/visual";
import { INSTANT_FEE_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "How settlement works", alternates: { canonical: "/docs/developers/settlement" } };

const CPI = `// Inside a Game program (block_puzzle's finalize, abridged): settle by CPI into tesoro_core.
// game_authority is the Game program's own ["authority"] PDA, so it signs with invoke_signed.
let signer = &[&[AUTHORITY_SEED, &[session.authority_bump]][..]];
tesoro_core::cpi::settle_match(
    CpiContext::new_with_signer(
        tesoro_core_program,
        tesoro_core::cpi::accounts::SettleMatch { game_authority, config, game_record, match_state },
        signer,
    )
    .with_remaining_accounts(payout_accounts), // per payout: recipient TesoroAccount, then its Holding of that Source
    result, // MatchResult::Opener | Joiner | Draw
)?;`;

export default function Page() {
  return (
    <DocPage href="/docs/developers/settlement">
      <p>
        A Match is settled by the Game program, not by a Studio server. The Game keeps its state in a rollup, works out the result itself, and then calls
        tesoro_core, signing as the authority registered for that Game. tesoro_core moves the Gemas.
      </p>

      <Sequence
        label="Match settlement sequence"
        caption="Who calls whom, in order. Only the Game program's registered authority can call settle_match."
        steps={[
          { from: "Player", to: "tesoro_core", call: "open_match / join_match", note: "Entries leave each Player's Holdings. Fee basis points are snapshotted." },
          { from: "Game", to: "Rollup", call: "delegate state accounts", note: "Pinned to the one approved TEE validator." },
          { from: "Players", to: "Rollup", call: "play", note: "Hidden state. The program enforces the rules and its own clock." },
          { from: "Rollup", to: "Solana", call: "commit and undelegate", note: "Hidden state is wiped, the final state returns to the base layer." },
          { from: "Anyone", to: "Game", call: "settle", note: "The Game works out the winner itself." },
          { from: "Game", to: "tesoro_core", call: "settle_match(result) by CPI", note: "Signed by the Game's authority PDA with invoke_signed." },
          { from: "tesoro_core", to: "Players", call: "credit payout lines, take Fees", note: "Leaderboard Fee goes to the Pool. A MatchWon event is emitted." },
        ]}
      />

      <H2 id="lifecycle">Match lifecycle in tesoro_core</H2>
      <DataTable
        head={["Instruction", "Who", "Effect"]}
        rows={[
          [<code key="1">open_match(match_id, game, entry)</code>, "A Player", "Creates the Match, draws the opener's entry from their Holdings, and snapshots the Platform and Studio Fee basis points. Entries are set by the admin (mainnet 100, 500 or 1,000; test mode 500, 1,000 or 2,500)."],
          [<code key="2">join_match</code>, "A Player", "Draws the joiner's entry, sets status Active, sets the refund deadline to one hour later."],
          [<><code>open_match_backed</code>, <code>join_match_backed</code></>, "A backed Player", "The same, funded by an accepted Offer's reserved Gemas. The Player's own Gemas are never touched."],
          [<code key="4">extend_match_deadline(new_deadline)</code>, "Game authority", "Pushes an Active, unexpired Match's refund deadline later, never earlier and at most 7 days from now, so a slow Game cannot be refunded out from under itself."],
          [<code key="5">settle_match(result)</code>, "Game authority only", "Settles once, from Open or Active to Settled. Result is Opener, Joiner or Draw."],
          [<code key="6">refund_match</code>, "Game authority any time; the opener of an unjoined Match; anyone after the deadline", "Returns every entry to its funder, unchanged. Liveness fallback."],
        ]}
      />

      <H2 id="game-interface">What a Game must provide</H2>
      <ol>
        <li>A program id and an <b>authority</b>: a PDA of the Game program is the norm (seeds <code>[&quot;authority&quot;]</code>), signing by <code>invoke_signed</code>. A server key also works but is the weaker trust boundary.</li>
        <li>Registration by whoever controls the Game program: <code>register_game(settle_authority, studio_bps)</code>, signed by the program&apos;s upgrade authority (or, for a program that can no longer be upgraded, by the program itself through its <code>[&quot;tesoro-register&quot;]</code> address). Each Game has its own record. The Studio Fee is at most 1,000 bps (10%) and Platform plus Studio Fee together are capped at 5,000 bps. The Studio recipient cannot be the Pool, the Treasury or the Platform recipient. A change waits 7 days.</li>
        <li>A way to compute the winner from state the Game controls. Block Puzzle replays moves against the Seed; Hold&apos;em plays out the chips; Trading Duel scores both Books&apos; picks against the recorded price line, closed by a pinned final price; Vanguard applies each move to the Battle and ends it on a captured Supply Truck, or on the surviving ranks at the limit.</li>
        <li>Liveness: timeouts and forfeits enforced by the program, with <code>extend_match_deadline</code> where the Game&apos;s own clock exceeds the one-hour default.</li>
      </ol>
      <Code label="rust, abridged">{CPI}</Code>
      <p>
        No change to tesoro_core was needed to support PDA authorities: <code>settle_match</code> only requires that the signer equals the registered
        authority.
      </p>

      <H2 id="pot">The Pot is a list of lines</H2>
      <p>
        A Pot is a list of <code>(source, amount)</code> lines per side. The winner receives the loser&apos;s <b>actual</b> lines, each keeping its Source,
        plus their own entry back. The recipient&apos;s Holding of each Source is credited; it counts as own-sourced only if they own that Source&apos;s
        Lock. Holdings for a payout must exist before settling; anyone can create them with <code>open_holding</code>, so a recipient cannot block a
        settlement.
      </p>

      <H3 id="fees">Fees</H3>
      <ul>
        <li>Fees are <code>platform_bps</code> (on Config, 200) plus the Game&apos;s <code>studio_bps</code> (300 for every Game), both snapshotted when the Match opens, plus the Leaderboard Fee <code>leaderboard_bps</code> (on Config, 100), read from Config when the Match settles. Together they are capped at 5,000 bps of the Pot.</li>
        <li>They are taken in Gemas from the <b>loser&apos;s lines</b>: Platform Fee first, then Studio Fee, then Leaderboard Fee, then (for a backed win) the Player&apos;s share of what remains. Lines are merged by Source and drained in ascending Source-address order.</li>
        <li>The Leaderboard Fee is paid to the Leaderboard Pool, a {BRAND.name} Account owned by the address <code>[&quot;leaderboard&quot;]</code>, as one more <code>(recipient, source)</code> payout line. Each decisive settlement also emits <code>MatchWon</code> (Player, loser, entry, points, season).</li>
        <li>Fees are floored, so the winner gets the dust. A Draw, abandonment or no-show takes none.</li>
        <li>Match Fees are separate from {BRAND.name}&apos;s other two revenues, which never touch a Pot: the Yield Fee (20% of the yield every Lock earns) and the Instant Redeem Fee ({INSTANT_FEE_PCT}% of won Gemas redeemed early). Both are kept by the Treasury.</li>
      </ul>

      <H3 id="allocation">Entry draw and bounds</H3>
      <ul>
        <li>An entry draws <code>own = min(entry, own_free)</code> from own-sourced Gemas first, the rest from won Gemas. The client supplies Holdings, own class first then won, each strictly ascending by Source address; a non-canonical draw is rejected.</li>
        <li><code>MAX_ENTRY_SOURCES = 8</code> Holdings per entry. A settlement therefore pays at most 19 <code>(recipient, source)</code> lines (20 for a backed win).</li>
        <li>Measured worst case before the Leaderboard Fee: a Block Puzzle <code>settle</code> with 18 payouts is 135,734 compute units and 1,091 bytes of the 1,232 limit as a legacy transaction, so no lookup table is needed.</li>
      </ul>

      <H2 id="backing">Backing in the ledger</H2>
      <p>
        <code>create_request</code>, <code>create_offer</code>, <code>accept_directed</code>, <code>apply_offer</code>, <code>accept_applicant</code>,{" "}
        <code>cancel_offer</code>, <code>expire_offer</code>. Offers reserve the Backer&apos;s entry on their Holdings. Requests and Offers live 24 hours; an
        accepted Offer has 24 hours to be used and is consumed when the backed Match opens or is joined. Win: the Backer&apos;s entry first, then the
        Player&apos;s share of the surplus after Fees, the rest to the Backer. Loss: the Backer loses the entry, nothing more.
      </p>

      <H2 id="errors">Errors</H2>
      <p>
        Ledger errors surface as custom program error <code>6100 + CoreError::code()</code>. Program errors start at 6000 (<code>Unauthorized</code> =
        6000, <code>GameNotRegistered</code> = 6001, <code>InvalidAccount</code> = 6003).
      </p>

      <Callout kind="note" title="Deeper reading">
        <p>
          The full account table, seeds and money rules are in the repository&apos;s <code>docs/tesoro-core.md</code>, and each Game has a design file in{" "}
          <code>docs/games/</code>. Hidden-state mechanics are on <Link href="/docs/developers/rollups">Private Ephemeral Rollups</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
