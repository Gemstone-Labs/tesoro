import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, Steps } from "@/components/docs/prose";
import { BackingBars, Shot } from "@/components/docs/visual";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Backing", alternates: { canonical: "/docs/backing" } };

export default function Page() {
  return (
    <DocPage href="/docs/backing" hero={<Shot name="backing" url={`${BRAND.domain}/backing`} alt="The Backing page with Requests from Players and a button to make an Offer" priority caption="Backing: Players ask to be backed, Backers make Offers. Sample data." />}>
      <p>
        A <b>Backing</b> is an agreement, accepted by both sides, in which a <b>Backer</b> funds a <b>Player&apos;s</b> full entry into one Match. If the
        Player wins, the Backer&apos;s entry comes back first and the rest is split by the share the Backer offered. If the Player loses, only the
        Backer bears it.
      </p>

      <H2 id="who">Who is who</H2>
      <DataTable
        head={["Role", "What they do", "What they risk"]}
        rows={[
          ["Backer", "Holds the Gemas that fund the entry, and chooses whom to back and on what terms.", "The entry, and nothing more. Their own Lock keeps paying back as usual."],
          ["Player", "Plays the Match. Needs no Gemas of their own.", "Nothing. A backed Player never owes anything and can never redeem or redirect the Backer's Gemas."],
        ]}
      />

      <H2 id="how">How a Backing is made</H2>
      <Steps
        items={[
          { title: "Request", body: <>A Player lists a public Request for a game and an entry size. It shows their real Match record, always with the sample size, for example &ldquo;1 of 1 won (100%)&rdquo;. A Request carries no split.</> },
          { title: "Offer", body: <>A Backer answers with an Offer: the game, the entry, and the Player&apos;s share of the surplus (10% to 90%). Every Offer answers a Request, so a Backer always picks whom they back.</> },
          { title: "Reservation", body: <>Creating an Offer reserves an <i>amount</i> of the Backer&apos;s own Gemas. They stay in the balance but cannot be spent. Cancelling, or letting the Offer expire, releases them. The actual Gemas are chosen by the program when the Match opens, by the same rule as any entry: fast ones first (see <Link href="/docs/gemas#own-first">Gemas</Link>). Only Listed Games can be Backed.</> },
          { title: "Accept", body: <>The other side accepts. Requests and Offers last 24 hours, and an accepted Backing has 24 hours to be used.</> },
          { title: "Play", body: <>The Player enters through the Queue or a Challenge link with the Backer&apos;s reserved Gemas. Once the Match starts, the Backing cannot be revoked.</> },
        ]}
      />

      <H2 id="split">The split, with numbers</H2>
      <p>
        Take a Match with a 1,000 Gema entry each, a Pot of 2,000, and an Offer that gives the Player 40% of the surplus. The Fees in this example are
        6% of the Pot (2% Platform, 3% Studio, 1% Leaderboard), taken from the loser&apos;s Gemas. See <Link href="/docs/fees">Fees</Link>.
      </p>
      <BackingBars />

      <DataTable
        head={["Step", "Gemas"]}
        rows={[
          ["The Backer's entry comes back first", "1,000"],
          ["Fees come out of the loser's 1,000", "120"],
          ["What is left of the loser's entry is the surplus", "880"],
          ["The Player's 40% of the surplus", "+352"],
          ["The Backer's 60% of the surplus", "+528"],
        ]}
        caption="Backed Player wins. 1,000 + 528 + 352 + 120 = the 2,000 Pot"
      />
      <DataTable
        head={["Outcome", "Backer", "Player"]}
        rows={[
          ["Player wins", "Entry back, plus their share of the surplus", "Their share of the surplus"],
          ["Player loses", "Loses the entry", "Owes nothing, has nothing to pay back"],
          ["Draw or refund", "Entry returns unchanged", "Nothing"],
        ]}
      />

      <Callout kind="warn" title="Honest limits">
        <p>
          A Backer can lose the whole entry on every Match. The Player&apos;s record on a Request is computed by the app from the Matches it can read, so a
          small sample says little. Backing has not been reviewed by a lawyer for any jurisdiction.
        </p>
      </Callout>
    </DocPage>
  );
}
