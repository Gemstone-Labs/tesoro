import Link from "next/link";
import type { ReactNode } from "react";
import { MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { INSTANT_FEE_PCT, INSTANT_PAYOUT_PCT } from "@/lib/chain/yield";

export const STEPS: { title: string; text: string; href: string; cta: string }[] = [
  { title: "Open a Position", text: "Lock a staking token in your Wallet. Its Principal is never played.", href: "/wallet", cta: "Wallet" },
  { title: "Take an Advance", text: "Get 80% of its projected yield for 1–12 months upfront, as Gemas.", href: "/wallet", cta: "Wallet" },
  { title: "Play a Match", text: "Pick a game and an entry. Win the Pot minus Fees.", href: "/play", cta: "Play" },
  { title: "Redeem", text: `Turn Gemas into their Source asset as its yield lands, or now for ${INSTANT_PAYOUT_PCT}%.`, href: "/wallet", cta: "Wallet" },
];

export const TOPICS: { id: string; title: string; qs: { q: string; a: ReactNode }[] }[] = [
  {
    id: "gemas",
    title: "Gemas and Positions",
    qs: [
      {
        q: "What is a Gema?",
        a: (
          <p>
            The one play unit on Tesoro, on every chain. A Gema is worth $0.01 when it is issued and is a claim on its Source: the Advance it
            came from. Gemas are equal at the table but not at redemption: a Gema redeems in its Source asset (SOL, ETH or HYPE). The{" "}
            <Link href="/docs/gemas">Docs</Link> go deeper.
          </p>
        ),
      },
      {
        q: "Where do my Gemas come from?",
        a: (
          <p>
            Open a Position in your <Link href="/wallet">Wallet</Link> by locking a staking token, then take an Advance: 80% of the Position&apos;s
            projected yield over a Horizon of 1 to 12 months (the yield after Tesoro&apos;s 20% Yield Fee), paid upfront as Gemas.
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
            a no-show refunds both entries. Every Match is settled once and recorded on Solana, where anyone can check it.
          </p>
        ),
      },
      {
        q: "How does Block Puzzle work?",
        a: (
          <>
            <p>
              You and your opponent get the same pieces and 90 seconds each; the higher score wins. Nobody can see the pieces before you press
              Start, and your score is checked by replaying your moves, so it can&apos;t be faked.
            </p>
            <p>
              You don&apos;t have to play at the same time: you can play before an opponent is paired, and the next Player in the Queue gets the same pieces. If nobody joins
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
        q: "How does Trading Duel work?",
        a: (
          <>
            <p>
              Pick where the price will be. Two Players watch the same live price (SOL, ETH or HYPE, chosen when the Match is opened) move across a
              grid of 12 columns, ten seconds each, with bands of price that scroll up and down to follow it. For every column you pick one box. If the line passes through your box
              while the column is live, you hit and score 100 points. After 12 columns, two and a half minutes, more points takes the Pot minus
              Fees. Equal points is a draw and refunds both entries.
            </p>
            <p>
              You get a 30 second head start before the line enters the first column, and you can change a pick for free until its column locks.
              A column locks ten seconds before the line reaches it, so you always pick at least ten seconds ahead. Your picks stay hidden from your
              opponent until each column locks; then both picks for it are shown. Points are scorekeeping inside the Match, not Gemas.
            </p>
          </>
        ),
      },
      {
        q: "What are the Fees?",
        a: (
          <p>
            On every Match, three, taken in Gemas from the loser&apos;s entry when it settles: a Platform Fee for Tesoro, a Studio Fee for the game&apos;s
            maker, and a Leaderboard Fee that fills the weekly prize pool. In test mode they are 2%, 3% and 1% of the Pot, 6% together. A draw
            or a refund pays none of them. Tesoro also keeps a Yield Fee on your Positions and a fee on Redeem now (below). Nothing is ever charged on your
            Principal.
          </p>
        ),
      },
      {
        q: "What is the Yield Fee?",
        a: (
          <p>
            Tesoro keeps 20% of the yield your Position earns, on SOL, ETH and HYPE alike. Your Position keeps the other 80%, and your Advance is
            sized on that 80%, so it is still repaid in the same time and your Unlock Estimate does not change. See <Link href="/docs/fees">Fees</Link>.
          </p>
        ),
      },
      {
        q: "Is my Principal ever charged?",
        a: (
          <p>
            No. The Yield Fee is taken from yield only, and no fee of any kind touches your Principal. It stays locked until your Debt is repaid, then
            it is yours to Unlock.
          </p>
        ),
      },
      {
        q: "Can I redeem won Gemas now?",
        a: (
          <p>
            Yes. Redeem now pays you {INSTANT_PAYOUT_PCT}% of the Gemas&apos; value in their Source asset today, instead of waiting for that Source&apos;s yield to
            land. It works for Gemas you won in SOL, ETH or HYPE. Your own Gemas cannot be redeemed this way.
          </p>
        ),
      },
      {
        q: `Why only ${INSTANT_PAYOUT_PCT}% when I redeem now?`,
        a: (
          <p>
            Because Tesoro pays you today and waits for the yield itself. It takes your Gemas, keeps {INSTANT_FEE_PCT}% for the wait and the risk, and redeems the
            Gemas at full value later. If you can wait, a normal Redeem pays 100%. If Tesoro&apos;s balance for that asset is short, Instant Redeem is
            refused and nothing moves.
          </p>
        ),
      },
      {
        q: "How does the Leaderboard work?",
        a: (
          <>
            <p>
              Every Match you win earns points, the same in every game: 5 for a 500 Gema entry, 10 for 1,000 and 25 for 2,500. Losses, draws and
              refunds earn none. When a Backer funds your entry, you get the points, because you played.
            </p>
            <p>
              Seasons run from Monday 00:00 UTC to the next Monday. When one ends, the top ten share the prize pool (the Leaderboard Fee of every Match) on a
              sliding scale: 25%, 18%, 13%, 10%, 8%, 7%, 6%, 5%, 4% and 4%. Ties go to whoever won first that week. With fewer than ten Players, the
              unclaimed shares stay in the pool for the next season. See the <Link href="/leaderboard">Leaderboard</Link>.
            </p>
          </>
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
            With your email and a one-time code, or with a wallet you already have: a Solana wallet such as Phantom, Solflare or Backpack, or an
            Ethereum wallet such as MetaMask or Rabby. You don&apos;t need a wallet to start. Either way you get one Tesoro Account, and
            Positions, Gemas, Matches and Backings belong to it.
          </p>
        ),
      },
      {
        q: "Which chains does Tesoro use?",
        a: (
          <p>
            Solana for SOL Positions, Matches and your Account; Ethereum (the Hoodi test network) for ETH Positions; HyperEVM for HYPE
            Positions. ETH and HYPE Positions stay on their own chain, and Tesoro keeps them in sync with your Account.
          </p>
        ),
      },
      {
        q: "Is this real money?",
        a: (
          <p>
            No. Tesoro runs on testnets with simulated staking tokens whose yield runs on a fast clock: 1 month is about 10 minutes. Get test
            tokens from the Get test buttons in your <Link href="/wallet">Wallet</Link>. What is and is not simulated is on the{" "}
            <Link href="/docs/risks">Risks and limits</Link> page of the Docs.
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
            Crossing chains usually takes 2 to 5 minutes from Ethereum, and about a minute from HyperEVM. You can leave the page. Taking the
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
            Yield earned on Ethereum or HyperEVM is applied to your Debt once it is reported to Tesoro. Press Report yield on the Position to send it
            now; it costs a small cross-chain fee.
          </p>
        ),
      },
      {
        q: "It says the price is updating",
        a: (
          <p>Opening a Position needs a fresh price, and it is refreshed every hour. Try again in a few minutes.</p>
        ),
      },
      {
        q: "A page won’t load",
        a: (
          <p>
            The test network is sometimes slow or busy. Press Try again or refresh the page. Nothing is lost: your Positions, Gemas and
            Matches are saved on Solana, not in your browser.
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
