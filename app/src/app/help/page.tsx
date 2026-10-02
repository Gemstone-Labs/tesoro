import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { BustCard, Button } from "@/components/ui";
import { MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import "./help.css";

export const metadata: Metadata = { title: "Help · Tesoro" };

const STEPS: { title: string; text: string; href: string; cta: string }[] = [
  { title: "Open a Position", text: "Lock a staking token in your Wallet. Its Principal is never played.", href: "/wallet", cta: "Wallet" },
  { title: "Take an Advance", text: "Get its projected yield for 1–12 months upfront, as Gemas.", href: "/wallet", cta: "Wallet" },
  { title: "Play a Match", text: "Pick a game and an entry. Win the Pot minus Fees.", href: "/play", cta: "Play" },
  { title: "Redeem", text: "Turn Gemas into their Source asset as its yield lands.", href: "/wallet", cta: "Wallet" },
];

const TOPICS: { id: string; title: string; qs: { q: string; a: ReactNode }[] }[] = [
  {
    id: "gemas",
    title: "Gemas and Positions",
    qs: [
      {
        q: "What is a Gema?",
        a: (
          <p>
            The one play unit on Tesoro, on every chain. A Gema is worth $0.01 when it is issued and is a claim on its Source: the Advance it
            came from. Gemas are equal at the table but not at redemption: a Gema redeems in its Source asset (SOL, ETH or HYPE).
          </p>
        ),
      },
      {
        q: "Where do my Gemas come from?",
        a: (
          <p>
            Open a Position in your <Link href="/wallet">Wallet</Link> by locking a staking token, then take an Advance: 100% of the Position&apos;s
            projected yield over a Horizon of 1 to 12 months, paid upfront as Gemas.
          </p>
        ),
      },
      {
        q: "Can I lose my Principal in a Match?",
        a: (
          <p>
            No. Principal is never entered into a Match and never pays Debt. What you can lose is the Gemas you enter. Your Principal stays
            locked until your own yield has repaid your Debt, then it comes back to you.
          </p>
        ),
      },
      {
        q: "How is my Debt repaid?",
        a: (
          <>
            <p>
              Automatically. All yield your Position earns goes to its Debt until the Debt reaches zero. There is no repay button and no way to
              skip it.
            </p>
            <p>
              The only other way to lower Debt is to Return your own unspent Gemas from the Wallet. Adding more to the Position does not pay Debt.
            </p>
          </>
        ),
      },
      {
        q: "What is the Unlock Estimate?",
        a: (
          <p>
            The projected date your Debt reaches zero. It is an estimate, not a promise: it moves with the actual yield. If yield slows, the lock
            lasts longer.
          </p>
        ),
      },
      {
        q: "Can I take another Advance?",
        a: (
          <p>A Position holds one open Advance at a time. You can take a new one once its Debt is back to zero.</p>
        ),
      },
    ],
  },
  {
    id: "matches",
    title: "Matches",
    qs: [
      {
        q: "How does a Match work?",
        a: (
          <p>
            Two Players enter the same amount: 500, 1,000 or 2,500 Gemas. The winner takes the Pot minus Fees. A draw, an abandoned Match or
            a no-show refunds both entries. Every Match is settled once, on chain, by its game&apos;s own program.
          </p>
        ),
      },
      {
        q: "How does Block Puzzle work?",
        a: (
          <>
            <p>
              You and your opponent play the same Seed for 90 seconds; the higher score wins. The pieces stay hidden until you press Start, and
              your score counts only as the server&apos;s replay of your moves against the Seed.
            </p>
            <p>
              It is async: you can play before an opponent is paired, and the next Player in the Queue plays the same Seed. If nobody joins
              before the Queue window ends, you can cancel and get your entry back.
            </p>
          </>
        ),
      },
      {
        q: "How does Heads-up Hold'em work?",
        a: (
          <>
            <p>
              Real time, no limit. Each Player starts with 1,500 Chips, the blinds rise every hand, and you have 30 seconds per action. The last
              stack standing takes the Pot minus Fees.
            </p>
            <p>
              Chips are scorekeeping inside the Match, not Gemas. If your opponent&apos;s clock runs out, you can claim the timeout.
            </p>
          </>
        ),
      },
      {
        q: "What are the Fees?",
        a: (
          <p>
            A Platform Fee for Tesoro and a Studio Fee for the game&apos;s maker, taken in Gemas from the loser&apos;s entry when the Match
            settles. On devnet they are 5% of the Pot together. Nothing is ever charged on your Principal, your Advance or a Redeem.
          </p>
        ),
      },
      {
        q: "Can I play a friend?",
        a: (
          <p>
            Yes. Press Challenge a friend on a game&apos;s page and share the link. The Match skips the Queue: whoever opens the link joins it.
          </p>
        ),
      },
    ],
  },
  {
    id: "redeem",
    title: "Winning and Redeem",
    qs: [
      {
        q: "Why are the Gemas I won Pending?",
        a: (
          <>
            <p>
              When you win, you receive the loser&apos;s actual Gemas, and each one keeps its Source: the loser&apos;s Position. They become
              redeemable as that Position&apos;s yield lands, shared pro rata among everyone holding Gemas from it.
            </p>
            <p>
              Your Wallet always shows Redeemable now and Pending side by side, with Pending broken down by Source. Pending is not lost.
            </p>
          </>
        ),
      },
      {
        q: "How do I Redeem?",
        a: (
          <p>
            From your <Link href="/wallet">Wallet</Link>. Redeem turns Gemas into their Source asset, as far as that Source&apos;s yield has
            accrued. Gemas from an ETH or HYPE Position are paid out on that chain, which takes a few minutes.
          </p>
        ),
      },
      {
        q: "Does winning unlock my Position sooner?",
        a: (
          <p>
            No. Only your own Position&apos;s yield, or returning your own unspent Gemas, lowers your Debt. Gemas you win are a separate claim on
            someone else&apos;s yield.
          </p>
        ),
      },
      {
        q: "What if the loser's yield slows down?",
        a: (
          <p>Then the Gemas you won from them stay Pending for longer. They become redeemable as soon as that yield lands.</p>
        ),
      },
      {
        q: "How do I get my Principal back?",
        a: (
          <p>
            When a Position&apos;s Debt reaches zero, press Unlock on it in your Wallet. The Principal comes back to you, minus a small reserve for
            yield still owed to unredeemed Gemas from that Position.
          </p>
        ),
      },
    ],
  },
  {
    id: "backing",
    title: "Backing",
    qs: [
      {
        q: "What is Backing?",
        a: (
          <p>
            A Backer pays a Player&apos;s whole entry into one Match. On a win the Backer&apos;s entry is returned first and the rest is split by
            the share in the Offer. On a loss only the Backer loses: the Player never takes on Debt.
          </p>
        ),
      },
      {
        q: "How do I get backed?",
        a: (
          <p>
            Post a Request on <Link href="/backing">Backing</Link> for a game and an entry size. It shows your real Match history. Backers answer
            with Offers, and you accept the one you want.
          </p>
        ),
      },
      {
        q: "How do I back a Player?",
        a: (
          <p>
            Send an Offer to a Player&apos;s Request, or post a public Offer that Players apply to and accept the one you choose. Either way you
            pick whom you back and the Player agrees to your terms.
          </p>
        ),
      },
      {
        q: "Can a Backing be cancelled?",
        a: (
          <p>
            Before the Match starts, you can cancel your Request or Offer. Once the Match starts, the Backing holds. A backed Player can never
            redeem or redirect the Backer&apos;s Gemas.
          </p>
        ),
      },
    ],
  },
  {
    id: "account",
    title: "Account and chains",
    qs: [
      {
        q: "How do I sign in?",
        a: (
          <p>
            With your email and a one-time code. Your Account holds one address per chain family (Solana and EVM), so you don&apos;t need a
            wallet extension. Positions, Gemas, Matches and Backings belong to your Account.
          </p>
        ),
      },
      {
        q: "Which chains does Tesoro use?",
        a: (
          <p>
            Solana devnet for SOL Positions, Matches and the ledger; Ethereum Hoodi for ETH Positions; HyperEVM testnet for HYPE Positions. ETH
            and HYPE Positions stay on their own chain, and LayerZero carries their messages to Solana.
          </p>
        ),
      },
      {
        q: "Is this real money?",
        a: (
          <p>
            No. Tesoro runs on testnets with simulated staking tokens whose yield runs on a fast clock: 1 month is about 10 minutes. Get test
            tokens from the Get test buttons in your <Link href="/wallet">Wallet</Link>.
          </p>
        ),
      },
    ],
  },
  {
    id: "trouble",
    title: "Troubleshooting",
    qs: [
      {
        q: "My ETH or HYPE Position is still crossing chains",
        a: (
          <p>
            LayerZero usually takes 2 to 5 minutes between Hoodi and Solana, and about a minute from HyperEVM. You can leave the page. Taking the
            Advance is the last step and needs your signature, so it continues when you come back to your Wallet.
          </p>
        ),
      },
      {
        q: "It says I don't have enough Gemas",
        a: (
          <p>
            Gemas reserved for your open Offers can&apos;t be entered again until you cancel the Offer. An entry can also draw on at most{" "}
            {MAX_ENTRY_SOURCES} Sources: if your Gemas are spread across many small Sources, Redeem a few of them first.
          </p>
        ),
      },
      {
        q: "My ETH or HYPE Position shows yield that is not reported",
        a: (
          <p>
            Yield earned on Hoodi or HyperEVM is applied to your Debt once it is reported to Solana. Press Report yield on the Position to send it
            now; it costs a small LayerZero fee.
          </p>
        ),
      },
      {
        q: "The price feed is stale",
        a: (
          <p>Opening a Position needs a fresh price. It is refreshed every hour; try again in a few minutes.</p>
        ),
      },
      {
        q: "A page could not read from Solana devnet",
        a: (
          <p>
            The devnet network is sometimes slow or rate-limited. Press Try again or refresh the page. Nothing is lost: your Positions, Gemas and
            Matches live on chain, not in your browser.
          </p>
        ),
      },
      {
        q: "My opponent never showed up",
        a: (
          <p>
            A no-show refunds both entries. In Block Puzzle, once the Queue window ends you can cancel and get your entry back from the
            Match&apos;s page. In Hold&apos;em, claim the timeout when your opponent&apos;s clock runs out.
          </p>
        ),
      },
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="help-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">How Tesoro works, and what to do when something gets stuck.</p>
        </div>
      </header>

      <section aria-labelledby="help-start" className="help-section">
        <h2 id="help-start" className="h-section">Start here</h2>
        <ol className="help-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="cut cut-card help-step">
              <span className="help-step-n" aria-hidden="true">{i + 1}</span>
              <b>{s.title}</b>
              <p>{s.text}</p>
              <Link href={s.href} className="help-step-link">
                {s.cta} <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <nav aria-label="Help topics" className="help-topics">
        {TOPICS.map((t) => (
          <a key={t.id} href={`#${t.id}`} className="cut cut-chip chip">
            {t.title}
          </a>
        ))}
      </nav>

      {TOPICS.map((t) => (
        <section key={t.id} id={t.id} aria-labelledby={`${t.id}-h`} className="help-section">
          <h2 id={`${t.id}-h`} className="h-section">{t.title}</h2>
          <div className="help-qs">
            {t.qs.map(({ q, a }) => (
              <details key={q} className="cut cut-card help-q">
                <summary>
                  {q}
                  <ChevronDown aria-hidden="true" />
                </summary>
                <div className="help-a">{a}</div>
              </details>
            ))}
          </div>
        </section>
      ))}

      <BustCard bust="himExplain" size={110}>
        <b>Still stuck?</b>
        <p>
          Refresh the page or sign in on another device: your Positions, Gemas and Matches are read from the chain, so nothing is lost. Your
          Match history shows every settled and refunded Match.
        </p>
        <div className="help-still">
          <Button size="sm" href="/matches">Match history</Button>
          <Button size="sm" href="/wallet">Wallet</Button>
        </div>
      </BustCard>
    </div>
  );
}
