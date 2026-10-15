import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { GameCards, PayoutBar, Shot } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Games and Matches", alternates: { canonical: "/docs/matches" } };

export default function Page() {
  return (
    <DocPage href="/docs/matches" hero={<GameCards />}>
      <H2 id="match">A Match</H2>
      <p>
        A <b>Match</b> is a head-to-head contest between two Players with equal Gema entries: <b>500, 1,000 or 2,500</b> (at issuance prices, $5, $10 or
        $25). The two entries form the <b>Pot</b>, held in escrow until the Match is settled, and a Match is settled exactly once.
      </p>
      <DataTable
        head={["Result", "What happens"]}
        rows={[
          ["A Player wins", "The winner gets their own entry back plus the loser's Gemas, minus Fees (see Fees). Fees come out of the loser's Gemas, so a winner always gets their own entry back whole."],
          ["Draw", "Both entries go back to the Players unchanged."],
          ["No-show or abandoned Match", "Both entries are refunded. A Match that nobody joins can be cancelled by its opener at any time, and anyone can refund it after the Queue window: 24 hours for Block Puzzle, one hour for the live games."],
        ]}
      />
      <p>
        Only the Game&apos;s own program can settle its Matches. Tesoro never decides a result by hand. See <Link href="/docs/fairness">Fairness and
        privacy</Link>.
      </p>

      <PayoutBar />

      <H2 id="finding-a-match">Finding an opponent</H2>
      <ul>
        <li>
          <b>Queue.</b> The waiting line for one game at one entry size. You are paired with the next entrant. In Block Puzzle you can play before an
          opponent is paired.
        </li>
        <li>
          <b>Challenge.</b> Open a Match for a specific opponent and send them a link. The link is the only way a Challenge reaches them: Tesoro does not
          deliver it for you.
        </li>
        <li>
          <b>Practice.</b> Each game has a practice mode against a local bot that costs nothing and has no stakes.
        </li>
      </ul>

      <H2 id="block-puzzle">Block Puzzle</H2>
      <p>
        An asynchronous puzzle. You and your opponent get <b>the same pieces</b>, so your scores are directly comparable, but you do not have to play at
        the same time. Each run lasts 90 seconds. The higher score wins; equal scores are a draw.
      </p>
      <ul>
        <li>The pieces are generated for the Match, and nobody, including you, can see them before your own run begins.</li>
        <li>Your score is not something you report. It is what the game program calculates by replaying your moves, and an illegal move is rejected.</li>
        <li>Your moves stay private until both runs are closed, so the second Player cannot copy the first.</li>
        <li>If you are first, you have a one-hour Queue window for an opponent to join. After someone joins, they have 24 hours to play their run; if they never begin, you win by forfeit.</li>
      </ul>

      <Shot name="block-puzzle" url="playtesoro.com/play/…" alt="A Block Puzzle run: the board, the three pieces and the score" caption="A Block Puzzle run. Both Players get the same pieces." />

      <H2 id="holdem">Hold&apos;em</H2>
      <p>
        Heads-up no-limit Texas Hold&apos;em, played in real time, as one sit-and-go per Match. Both Players start with <b>1,500 Chips</b>. Hands repeat
        with rising blinds until one Player holds every Chip.
      </p>
      <ul>
        <li>Chips are only the scorekeeping inside a Match and have no value outside it. Your entry leaves your balance once, at the start, and the Pot is settled once, at the end.</li>
        <li>You have 30 seconds for each action. Three missed turns in a row forfeit the Match.</li>
        <li>The deck is shuffled with randomness from both Players and a random-number service; nobody can see the deck, and your hole cards are visible only to you. Cards are revealed only at a showdown.</li>
      </ul>

      <Shot name="holdem" url="playtesoro.com/play/…" alt="A Hold'em table, heads-up, with the pot and action buttons" caption="Heads-up Hold'em. Only you see your hole cards." />

      <H2 id="trading-duel">Trading Duel</H2>
      <p>
        A real-time price grid for two. You and your opponent watch the same live price on one asset chosen for the Match: SOL, ETH or HYPE. The
        grid has 12 columns of ten seconds and bands of price that follow the line. For each column you pick one box, and if the live line passes through it, you hit and
        score <b>100 points</b>.
      </p>
      <ul>
        <li>You get a 30 second head start before the line enters the first column. The Match is 12 columns long: two and a half minutes in all.</li>
        <li>You can change a pick for free until its column locks. A column locks ten seconds before the line reaches it, so you always pick ahead of the line, never on it.</li>
        <li>Your picks stay hidden from your opponent until each column locks. Then both picks for it are shown, and the two of you race column by column.</li>
        <li>A column with no pick scores nothing. A hit means the line touched your box at any moment during the column.</li>
        <li>At the end, more points wins. Equal points, including neither Player picking, are a draw and both entries are refunded.</li>
      </ul>

      <H3 id="chips">Chips are not Gemas</H3>
      <p>
        In Hold&apos;em, Chips are the in-match score units (Trading Duel scores points the same way). They never become Gemas or leave the Match. Gemas enter a Match once and
        leave once; Chips are only the scorekeeping in between.
      </p>

      <Callout kind="note" title="Seeing a Match you are not in">
        <p>
          Anyone can open a Match page and see both Players, the scores or the result, the entry and the Fees. Hidden information, such as your cards
          or your picks before their column locks, are shown only to you until the Match is over.
        </p>
      </Callout>
    </DocPage>
  );
}
