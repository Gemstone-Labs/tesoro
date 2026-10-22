import Link from "next/link";
import type { ReactNode } from "react";
import { fmtGemas } from "@/lib/format";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { fmtEntryList } from "@/lib/format";
import { INSTANT_FEE_PCT, INSTANT_PAYOUT_PCT, REDEEM_PAYOUT_PCT, YIELD_FEE_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const STEPS: { title: string; text: string; href: string; cta: string }[] = [
  { title: "Get Gemas", text: "Lock a staking token in your Vault. What you lock is never played.", href: "/vault", cta: "Vault" },
  { title: "Take an Advance", text: "Get its projected yield for 1–12 months upfront, as Gemas.", href: "/vault", cta: "Vault" },
  { title: "Play a Match", text: "Pick a game and an entry. Win the Pot minus Fees.", href: "/play", cta: "Play" },
  { title: "Redeem", text: `Turn Gemas into the coin they came from as its yield lands (${REDEEM_PAYOUT_PCT}% of their value), or now for ${INSTANT_PAYOUT_PCT}%.`, href: "/vault", cta: "Vault" },
];

export const TOPICS: { id: string; title: string; qs: { q: string; a: ReactNode }[] }[] = [
  {
    id: "gemas",
    title: "Gemas and Locks",
    qs: [
      {
        q: "What is a Gema?",
        a: (
          <p>
            The one play unit on {BRAND.name}, on every chain. A Gema is worth $0.01 when it is issued and is a claim on the Lock it came from, through the Advance it
            was issued from. Gemas are equal at the table but not at redemption: a Gema redeems in the coin of its Lock (SOL, ETH or HYPE). The{" "}
            <Link href="/docs/gemas">Docs</Link> go deeper.
          </p>
        ),
      },
      {
        q: "Where do my Gemas come from?",
        a: (
          <p>
            Get Gemas in your <Link href="/vault">Vault</Link> by locking a staking token, then take an Advance: the Lock&apos;s
            projected yield over a Length of 1 to 12 months, paid upfront as Gemas. {BRAND.name}&apos;s {YIELD_FEE_PCT}% Yield Fee comes out later, when you cash Gemas out.
          </p>
        ),
      },
      {
        q: "Can I lose what I lock in a Match?",
        a: (
          <p>
            No. What you lock is never entered into a Match and never pays back an Advance. What you can lose is the Gemas you enter. Your coins stay
            locked until your own yield has paid back your Advance, then they come back to you.
          </p>
        ),
      },
      {
        q: "How is my Advance paid back?",
        a: (
          <>
            <p>
              Automatically. All yield your Lock earns goes to paying back the Advance until nothing is left. There is no repay button and no way to
              skip it. What is left to pay back on a SOL Lock falls with the clock: nothing needs refreshing, and Redeem and Unlock always use the latest figure.
            </p>
            <p>
              The only other way to lower it is to Return your own unspent Gemas from the Vault. Adding more to the Lock does not pay it back.
            </p>
          </>
        ),
      },
      {
        q: "What is the Unlock Estimate?",
        a: (
          <p>
            The projected date nothing is left to pay back. It is an estimate, not a promise: it moves with the actual yield. If yield slows, the lock
            lasts longer.
          </p>
        ),
      },
      {
        q: "Can I take another Advance?",
        a: (
          <p>A Lock holds one open Advance at a time. You can take a new one once nothing is left to pay back.</p>
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
            Two Players enter the same amount: {fmtEntryList(ENTRY_SIZES)} Gemas. The winner takes the Pot minus Fees. A draw, an abandoned Match or
            a no-show refunds both entries. Every Match is settled once and recorded on Solana, where anyone can check it.
          </p>
        ),
      },
      {
        q: "How does Block Burst work?",
        a: (
          <>
            <p>
              You and your opponent play the same pieces at the same time for 90 seconds; the higher score wins. Nobody can see the pieces before the
              count reaches zero, and your score is checked by replaying your moves, so it can&apos;t be faked.
            </p>
            <p>
              You see your opponent&apos;s last score until the final 10 seconds, when both scores are hidden. Stay on the page once you are paired: a Player who
              does not check in within a minute loses the Match. If nobody joins, you can cancel and get your entry back.
            </p>
          </>
        ),
      },
      {
        q: "How does Buckshot Hold'em work?",
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
            On every Match, three, taken in Gemas from the loser&apos;s entry when it settles: a Platform Fee for {BRAND.name}, a Studio Fee for the game&apos;s
            maker, and a Leaderboard Fee that fills the weekly prize pool. In test mode they are 2%, 3% and 1% of the Pot, 6% together. A draw
            or a refund pays none of them. {BRAND.name} also keeps a Yield Fee on your Locks and a fee on Redeem now (below). Nothing is ever charged on
            what you lock.
          </p>
        ),
      },
      {
        q: "What is the Yield Fee?",
        a: (
          <p>
            {BRAND.name} keeps {YIELD_FEE_PCT}% of the value of Gemas when they are cashed out, on SOL, ETH and HYPE alike. Your Advance is the whole projected yield, so it
            is repaid in the Length you picked and your Unlock Estimate does not change. A Redeem pays {REDEEM_PAYOUT_PCT}% of the Gemas&apos; value: 1,000 Gemas worth $10.00 pay $8.00. Gemas
            that pay a fee or a prize are not charged it again. See <Link href="/docs/fees">Fees</Link>.
          </p>
        ),
      },
      {
        q: "Is what I lock ever charged?",
        a: (
          <p>
            No. The Yield Fee is taken from Gemas when you cash them out, and no fee of any kind touches what you lock. It stays locked until your Advance is paid back, then
            it is yours to Unlock.
          </p>
        ),
      },
      {
        q: "Can I redeem won Gemas now?",
        a: (
          <p>
            Yes. Redeem now pays you {INSTANT_PAYOUT_PCT}% of the Gemas&apos; value in the coin they came from today, instead of waiting for that Lock&apos;s yield to
            land. It works for Gemas you won in SOL, ETH or HYPE, and for your own Gemas too. You choose how many.
          </p>
        ),
      },
      {
        q: `Why only ${INSTANT_PAYOUT_PCT}% when I redeem now?`,
        a: (
          <p>
            Because {BRAND.name} pays you today and waits for the yield itself. It takes your Gemas, keeps {INSTANT_FEE_PCT}% of what a Redeem would pay for the wait and the risk, and redeems the
            Gemas later. A normal Redeem pays {REDEEM_PAYOUT_PCT}% of the value (after the {YIELD_FEE_PCT}% Yield Fee), so if you can wait you get more: 1,000 Gemas pay $8.00 later or $6.00 now. If {BRAND.name}&apos;s balance for that asset is short, Instant Redeem is
            refused and nothing moves.
          </p>
        ),
      },
      {
        q: "How does the Leaderboard work?",
        a: (
          <>
            <p>
              Every Match you win earns points, the same in every game: one for every 100 Gemas of entry ({ENTRY_SIZES.map((e) => `${e / 100} for ${fmtGemas(e)}`).join(", ")}). Losses, draws and
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
            Yes. Press Challenge a friend on a game&apos;s page and share the link. The Match skips the Queue: whoever opens the link joins it. Add them as a
            Friend (on their Account page, after a Match, or with your add-me link from the Friends page) and you can pick them for a Challenge: it shows on
            their Friends page too.
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
              When you win, you receive the loser&apos;s actual Gemas, and each one keeps the Lock it came from: the loser&apos;s. They become
              redeemable as that Lock&apos;s yield lands, shared pro rata among everyone holding Gemas from it.
            </p>
            <p>
              Your Vault always shows Redeemable now and Pending side by side, with Pending broken down by coin. Pending is not lost.
            </p>
          </>
        ),
      },
      {
        q: "How do I Redeem?",
        a: (
          <p>
            From your <Link href="/vault">Vault</Link>. Redeem turns Gemas into the coin they came from, as far as that Lock&apos;s yield has
            been earned. Gemas from an ETH or HYPE Lock are paid out on that chain, which takes a few minutes.
          </p>
        ),
      },
      {
        q: "Does winning unlock my Lock sooner?",
        a: (
          <p>
            No. Only your own Lock&apos;s yield, or returning your own unspent Gemas, lowers what is left to pay back. Gemas you win are a separate claim on
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
        q: "How do I get my coins back?",
        a: (
          <p>
            When a Lock&apos;s nothing is left to pay back, press Unlock on it in your Vault. Your coins come back to you, minus a small reserve for
            yield still owed to unredeemed Gemas from that Lock.
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
            the share in the Offer. On a loss only the Backer loses: the Player never has anything to pay back.
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
            Pick a Player&apos;s Request on the Backing board and make an Offer on it. You pick whom you back, and the Player accepts or declines
            your terms.
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
            Ethereum wallet such as MetaMask or Rabby. You don&apos;t need a wallet to start. Either way you get one {BRAND.name} Account, and
            Locks, Gemas, Matches and Backings belong to it.
          </p>
        ),
      },
      {
        q: `Which chains does ${BRAND.name} use?`,
        a: (
          <p>
            Solana for SOL Locks, Matches and your Account; Ethereum (the Hoodi test network) for ETH Locks; HyperEVM for HYPE
            Locks. ETH and HYPE Locks stay on their own chain, and {BRAND.name} keeps them in sync with your Account.
          </p>
        ),
      },
      {
        q: "Is this real money?",
        a: (
          <p>
            No. {BRAND.name} runs on testnets with simulated staking tokens whose yield runs on a fast clock: 1 month is about 10 minutes. Get test
            tokens from the Get test buttons in your <Link href="/vault">Vault</Link>. What is and is not simulated is on the{" "}
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
        q: "My ETH or HYPE Lock is still crossing chains",
        a: (
          <p>
            Crossing chains usually takes 2 to 5 minutes from Ethereum, and about a minute from HyperEVM. You can leave the page. Taking the
            Advance is the last step and needs your signature, so it continues when you come back to your Vault.
          </p>
        ),
      },
      {
        q: "It says I don't have enough Gemas",
        a: (
          <p>
            Gemas reserved for your open Offers can&apos;t be entered again until you cancel the Offer, and Gemas staged for an entry that is still being prepared are held until it opens or you cancel it. Everything else counts, however many Locks it comes from.
          </p>
        ),
      },
      {
        q: "My ETH or HYPE Lock shows yield that is not counted yet",
        a: (
          <p>
            Yield earned on Ethereum or HyperEVM reaches {BRAND.name} when you Redeem or Unlock. Those buttons fetch the latest yield first, which usually takes a
            minute or two, then carry on. If you leave in between, it still lands and the next press goes straight through.
          </p>
        ),
      },
      {
        q: "It says the price is updating",
        a: (
          <p>Locking needs a fresh price, and it is refreshed every hour. Try again in a few minutes.</p>
        ),
      },
      {
        q: "A page won’t load",
        a: (
          <p>
            The test network is sometimes slow or busy. Press Try again or refresh the page. Nothing is lost: your Locks, Gemas and
            Matches are saved on Solana, not in your browser.
          </p>
        ),
      },
      {
        q: "My opponent never showed up",
        a: (
          <p>
            A no-show refunds both entries. In Block Burst, a Player who does not check in within a minute loses the Match, so if your opponent
            never shows up you win; if nobody checks in, both entries come back. In Hold&apos;em, claim the timeout when your opponent&apos;s clock runs out.
          </p>
        ),
      },
    ],
  },
];
