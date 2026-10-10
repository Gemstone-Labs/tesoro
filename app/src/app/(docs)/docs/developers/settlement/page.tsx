import type { Metadata } from "next";
import Link from "next/link";
import { Callout, Code, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";

export const metadata: Metadata = { title: "How settlement works", alternates: { canonical: "/docs/developers/settlement" } };

const CPI = `// Inside a Game program (block_puzzle's finalize, abridged): settle by CPI into tesoro_core.
// game_authority is the Game program's own ["authority"] PDA, so it signs with invoke_signed.
let signer = &[&[AUTHORITY_SEED, &[session.authority_bump]][..]];
tesoro_core::cpi::settle_match(
    CpiContext::new_with_signer(
        tesoro_core_program,
        tesoro_core::cpi::accounts::SettleMatch { game_authority, config, match_state },
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

      <H2 id="lifecycle">Match lifecycle in tesoro_core</H2>
      <DataTable
        head={["Instruction", "Who", "Effect"]}
        rows={[
          [<code key="1">open_match(match_id, game, entry)</code>, "A Player", "Creates the Match, draws the opener's entry from their Holdings, and snapshots the Platform and Studio Fee basis points. Entries: 500, 1,000 or 2,500."],
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
        <li>Registration by the admin: <code>register_game(game, authority, studio_bps)</code>. Up to 8 Games can be registered. Platform plus Studio Fee together are capped at 5,000 bps.</li>
        <li>A way to compute the winner from state the Game controls. Block Puzzle replays moves against the Seed; Hold&apos;em plays out the chips; Trading Duel marks both books at a pinned final price.</li>
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
        Position. Holdings for a payout must exist before settling; anyone can create them with <code>open_holding</code>, so a recipient cannot block a
        settlement.
      </p>

      <H3 id="fees">Fees</H3>
      {/* TODO(verify-after-merge): Leaderboard Fee (1%) as a third Fee: where tesoro_core takes it, in which order, and into which account. Rewrite this section from the merged code. */}
      <ul>
        <li>Fees are <code>platform_bps</code> (on Config, 200) plus the Game&apos;s <code>studio_bps</code> (300 for all three launch Games), both snapshotted when the Match opens.</li>
        <li>They are taken in Gemas from the <b>loser&apos;s lines</b>: Platform Fee first, then Studio Fee, then (for a backed win) the Player&apos;s share of what remains. Lines are merged by Source and drained in ascending Source-address order.</li>
        <li>The Leaderboard Fee of 1% is an additional Fee of the same kind on every Match, paid into the Leaderboard Pool.</li>
        <li>Fees are floored, so the winner gets the dust. A Draw, abandonment or no-show takes none.</li>
      </ul>

      <H3 id="allocation">Entry draw and bounds</H3>
      <ul>
        <li>An entry draws <code>own = min(entry, own_free)</code> from own-sourced Gemas first, the rest from won Gemas. The client supplies Holdings, own class first then won, each strictly ascending by Source address; a non-canonical draw is rejected.</li>
        <li><code>MAX_ENTRY_SOURCES = 8</code> Holdings per entry. A settlement therefore pays at most 18 <code>(recipient, source)</code> lines (19 for a backed win).</li>
        <li>Measured worst case on devnet: a Block Puzzle <code>settle</code> with 18 payouts is 135,734 compute units and 1,091 bytes of the 1,232 limit as a legacy transaction, so no lookup table is needed.</li>
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
