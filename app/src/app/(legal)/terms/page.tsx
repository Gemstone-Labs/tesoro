import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal/LegalPage";
import { ENTITY } from "@/lib/legal/entity";
import { BRAND } from "@/lib/brand";

// DRAFT PENDING LEGAL REVIEW: written in-house, not yet reviewed by a lawyer. See lib/legal/entity.ts.
const TITLE = "Terms of Service";
const DESCRIPTION = `The rules for using ${BRAND.name}, from ${BRAND.legalName}`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: { title: `${TITLE} · ${BRAND.name}`, description: DESCRIPTION, siteName: BRAND.name, type: "website", images: "/opengraph-image.png" },
  twitter: { card: "summary_large_image", title: `${TITLE} · ${BRAND.name}`, description: DESCRIPTION, images: "/twitter-image.png" },
};

export default function Terms() {
  return (
    <LegalPage title={TITLE} lede={DESCRIPTION}>
      <Section id="who" title="Who we are and what these Terms cover">
        <p>
          {BRAND.name} is made and run by {ENTITY.name}, {ENTITY.form} (&ldquo;{BRAND.companyName}&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;){ENTITY.address ? `, ${ENTITY.address}` : ""}. These Terms are
          the agreement between you and {BRAND.companyName} for the {BRAND.name} website, apps, smart contracts and related services (together, &ldquo;{BRAND.name}&rdquo;). By
          signing in, entering a Match or otherwise using {BRAND.name} you agree to them and to our <Link href="/privacy">Privacy Policy</Link>. If you do not agree,
          do not use {BRAND.name}.
        </p>
        <p>
          Words with capital letters, such as Lock, Locked amount, Advance, Length, Gema, Match, Pot and Season, mean what they mean in the{" "}
          <Link href="/docs">Docs</Link>. The Docs explain how {BRAND.name} works; these Terms are the binding rules. If they differ, these Terms win.
        </p>
      </Section>

      <Section id="eligibility" title={`Who may use ${BRAND.name}`}>
        <ul>
          <li>You must be at least {ENTITY.minAge} years old, and old enough to enter binding contracts where you live. We ask you to confirm this, and we rely on what you tell us.</li>
          <li>You must not use {BRAND.name} if the law where you live forbids it, or forbids staking products, skill games or prize contests. No country is blocked today, so you alone are responsible for knowing and following the law that applies to you. We may restrict or end availability in any place at any time, with or without notice.</li>
          <li>You must not use {BRAND.name} if you are on a sanctions list, or act for someone who is.</li>
          <li>At mainnet launch, creating an Account needs an Invite, one for each waitlist member, until we open {BRAND.name} to everyone. An Invite is for one person and cannot be sold or passed on.</li>
          <li>One person, one Account. Do not create more than one, and do not use someone else&apos;s.</li>
        </ul>
      </Section>

      <Section id="test-mode" title="Test mode">
        <p>
          While {BRAND.name} runs on test networks (&ldquo;test mode&rdquo;), yield is simulated and speeded up, and Gemas, Locks and anything else shown have
          no real value. Nothing you hold in test mode can be exchanged for money, and we may reset or remove test mode balances and data at any time. These
          Terms apply to test mode too, except the parts that only make sense for real assets.
        </p>
      </Section>

      <Section id="accounts" title="Your Account and wallets">
        <p>
          You sign in with an email or a wallet, through our sign-in provider. Your Account holds your Locks, Gemas, Match history and Backings, and
          lives on public blockchains. You are responsible for your email, your wallets, your keys and everything done with them. We cannot recover keys,
          reverse transactions or restore access you lost. Tell us quickly at {ENTITY.contactEmail} if you think your access was compromised.
        </p>
        <p>
          Your Profile name and picture are public and kept on chain. Do not use a name or picture that is unlawful, hateful, misleading, or that
          impersonates someone. We may hide or remove them in our app.
        </p>
      </Section>

      <Section id="positions" title="Locks and Advances">
        <ul>
          <li>
            A <b>Lock</b> holds a staking token you own in {BRAND.name}&apos;s programs or vaults. We do not take ownership of it and we never play with what
            you lock (its <b>Locked amount</b>): no Match entry, fee or Backing draws on it, and it never pays back an Advance.
          </li>
          <li>
            An <b>Advance</b> issues you Gemas upfront against the yield your Lock is projected to earn over the <b>Length</b> you choose. It is not a loan
            or a line of credit. It leaves an amount <b>left to pay back</b>, in the Lock&apos;s own asset, that only the Lock&apos;s earned yield (or the return
            of Gemas issued from it) can reduce. The Lock stays locked until nothing is left to pay back.
          </li>
          <li>
            The <b>Unlock Estimate</b> is an estimate, not a promise. It moves with the staking provider&apos;s real yield. If yield slows, your lock lasts longer.
            If yield stops, it may not end at all.
          </li>
          <li>
            <b>Extend</b> adds months to an open Advance, within your Extend Limit and no more than once every 24 hours. Lowering the Extend Limit applies at once;
            raising it applies 24 hours later.
          </li>
          <li>
            We may change which staking token and provider (for example Jito, Lido or Kinetiq) new Locks use. Existing Locks keep the token they started with.
          </li>
          <li>
            We take a <b>Yield Fee</b> of 20% of yield when it is cashed out: when Gemas are Redeemed (you receive 80% of their value), when Gemas are sold by Instant Redeem, when we
            redeem Gemas we bought, and on a Lock&apos;s free yield when it is unlocked. We take it once per cash-out and never on a Locked amount, on fee Gemas or on prize Gemas.
            Half of the Yield Fee is ours and half is owed to the Leaderboard Pool for Season prizes, both counted when the cash-out happens. We do not spend the Pool&apos;s half, or
            what holders of an unlocked Lock are still owed.
          </li>
        </ul>
      </Section>

      <Section id="gemas" title="Gemas">
        <p>
          A Gema is the play unit across {BRAND.name}. It is worth $0.01 at the moment it is issued. It is a claim on the earned yield of the Advance it was issued from, not a
          currency, a security, a deposit or a stored value account with us, and it is not insured. Gemas are equal at the table but not at redemption: what a
          Gema redeems for follows the asset of that Advance and the yield actually earned.
        </p>
        <p>
          Gemas that have been repaid are claims on the staking token their yield was worth when it landed, not on a fixed amount of the coin. <b>If the staking token is
          slashed or loses value, the value of your repaid Gemas falls with it, as if you held the token yourself, and we do not make up the difference.</b> We keep no cushion for this.
        </p>
        <p>
          <b>If the staking token&apos;s rate falls after your yield was paid out, you get back what is left of your tokens, which can be worth less than the SOL you locked.</b> The Unlock screen shows the amount before you confirm it, and we do not make up the difference.
        </p>
        <ul>
          <li><b>Redeem</b> turns Gemas into the asset they came from, only as far as the yield of the Lock they came from has actually been earned and has reached those Gemas under the payout order below. Winning Gemas never shortens your own lock. The amount you can Redeem now does not go down unless you Redeem or spend those Gemas.</li>
          <li>
            <b>Payout order.</b> Yield that lands on an Advance after a fee was taken from it repays that Advance&apos;s Gemas in this order: first the Platform Fee Gemas, then the Studio
            Fee Gemas of Listed Games, then the Leaderboard Fee Gemas, then all other Gemas of the Advance in proportion to what each still waits for, and last the Gemas added by each
            Extend, each after everything issued before it. A Gema keeps its place in this order for its whole life. The order changes who is paid first; it does not change what the owner of the
            Lock has left to pay back or the Unlock Estimate. The Fee Gemas we receive are therefore repaid before yours, and winners can wait longer for Gemas of Advances where fees were taken.
          </li>
          <li>
            <b>Instant Redeem</b> is an order. You ask us to buy Gemas, won or your own, whose yield has not landed yet. The Gemas wait in the order and cannot be played. We may fill the order in
            full, in part or not at all, by hand or by a rule we switch on, only while the Treasury for that asset has enough that we may spend. When we fill, the Yield Fee comes off the value of
            the filled Gemas at that moment and then a 25% Instant Redeem Fee: you receive 60% of their value. One fifth of the Instant Redeem Fee is owed to the Leaderboard Pool and the rest is
            {BRAND.name}&apos;s. You may cancel an unfilled order at any time, and an order nobody fills expires and returns the Gemas unchanged. Yield that landed on your Gemas, also while the
            order waits, is Redeemed for you (less the Yield Fee) and is not sold.
          </li>
          <li>Won Gemas can wait a long time, or without an end date, if the yield of the loser&apos;s Lock collapses.</li>
          <li>Gemas can be used to play and redeem as described here. They cannot be sold to or bought from us for money, except through Instant Redeem as described above.</li>
          <li>
            <b>Which Gemas an entry uses.</b> The program chooses them, not you or the app: your own Gemas first, then Gemas you won with the earliest planned repayment date first. The Gemas an opponent
            wins from you are therefore the fastest ones you had. If an entry needs more pieces than one transaction can carry, it is put together in steps (an Entry Ticket) that you can cancel and that
            expire back to you untouched.
          </li>
        </ul>
      </Section>

      <Section id="matches" title="Matches, entries and fees">
        <p>
          A Match is a head-to-head contest of skill between two Players with equal Gema entries, settled once. The winner takes the Pot minus fees. A draw or an
          abandoned Match refunds both entries. A Player who is paired and does not show up loses the Match. Some Games, such as Hold&apos;em, include chance within a hand. You can lose everything you enter.
        </p>
        <ul>
          <li>Fees on every Pot are fixed when the Match opens: a Platform Fee of 2%, a Studio Fee of 3% (set by the Game&apos;s Studio, never more than 10% of the Pot) and a Leaderboard Fee of 1%. A draw or refund pays none, except that a no-show (neither Player showed up, or both checked in and neither acted) costs each side the Platform Fee.</li>
          <li>
            <b>7-day limit.</b> No Match can start settling more than 7 days after it opened, in any Game. After that, or if the Game&apos;s program was upgraded to different code after the Match opened,
            the Match can only be refunded, and anyone can run the refund. Big Pots are settled or refunded in steps that anyone can continue.
          </li>
          <li>
            <b>Listed Games.</b> Anyone who controls a Game&apos;s program may register it. We list the Games we accept (free to apply, then US$500 a year), tied to the exact build we approved. Only a Listed Game
            earns Points, has its Studio Fee repaid ahead of other holders, can be Backed, and has its network costs paid by us. We do not warn you about unlisted Games and are not responsible for them: they
            are run by their own Studios outside our control. Our own Games are Listed.
          </li>
          <li>
            <b>Network costs.</b> In Listed Games we pay the network costs (such as Solana fees and refundable storage rent) of your Matches and redemptions on Solana, only for Accounts that hold Gemas and within
            limits per Account and in total. We may pause this for new Matches at any time. Settling, refunding and redeeming keep working, and if you hold SOL you can pay your own costs. Storage rent we paid
            comes back to us when the storage is no longer needed.
          </li>
          <li>Results are decided by the Game&apos;s program. For Games with a shared Seed, a score counts only as the server&apos;s replay of your inputs.</li>
          <li>In Block Burst, a paired Player who does not check in loses that Match.</li>
          <li>You are playing other people, not us. We do not guarantee that an opponent will be found, will finish, or will play fairly.</li>
          <li>{BRAND.name} is not a casino, a sportsbook or a lottery. We do not offer games against the house.</li>
        </ul>
      </Section>

      <Section id="backing" title="Backing">
        <p>
          A Backing is an agreement between a Backer and a Player, accepted by both, in which the Backer funds the Player&apos;s full entry into one Match of a Listed Game. An Offer holds back an amount of the Backer&apos;s Gemas; the program draws the actual Gemas by the rule above when the Match opens. On
          a win the Backer&apos;s entry is returned first and the remainder is split as the Offer said. It cannot be revoked once the Match starts. Only the
          Backer bears a loss. We are not a party to the Backing, do not advise on it, and do not guarantee any return. Back only what you can lose.
        </p>
      </Section>

      <Section id="seasons" title="Seasons and the Leaderboard">
        <p>
          Each Season runs one week, Monday 00:00 UTC to the next Monday. Wins earn Points as the Docs describe, with a cap on Points from repeat wins against the
          same opponent. The Leaderboard Pool, funded by Leaderboard Fees and by half of the Yield Fee, is paid to top Players 48 hours after a Season ends. The Pool&apos;s budget is fixed when the Season is recorded, and every rank is paid the same mix of coins (SOL, ETH, HYPE) from it. Prize Gemas are backed by the staking tokens set aside for them and can be Redeemed at once, but their value follows the staking token. Only wins in Listed Games earn Points. In that window we may review the
          Season and void any Player we find has broken these Terms; their share and anything not paid rolls into the next Season. Anyone can rebuild a Season
          from public events to check our numbers. Our decision on a void is final.
        </p>
      </Section>

      <Section id="fair-play" title="Fair play">
        <p>You agree not to, and not to help anyone to:</p>
        <ul>
          <li>use bots, scripts, solvers, overlays or any automation or outside assistance to play, queue or decide for you;</li>
          <li>hold more than one Account, or play against your own or a friend&apos;s Account to farm Points, fees or payouts (including collusion, chip dumping and soft play);</li>
          <li>exploit a bug, call our programs in a way not meant for Players, or interfere with a Match, a Season, our keys, servers or the networks we use;</li>
          <li>use stolen, borrowed or illegally obtained funds, or use {BRAND.name} to launder money or evade sanctions;</li>
          <li>harass others, or misuse a Profile, a Challenge link or a share card.</li>
        </ul>
        <p>
          If we reasonably believe you broke these rules, we may void your Matches, withhold or take back payouts and Points, disqualify you from a Season, restrict
          or end your access in our apps, and report you where the law requires. Smart contracts hold what you lock; we cannot take it, but we can stop you using our
          apps, queues and payouts.
        </p>
      </Section>

      <Section id="protections" title="Protections">
        <p>{BRAND.name} gives you tools to stay in control. Use them early.</p>
        <ul>
          <li><b>Entry Limit:</b> your own cap on the Gemas you may enter into Matches in any 7 days. Lowering applies at once; raising applies 24 hours later.</li>
          <li><b>Break:</b> 1 day to 6 weeks in which you cannot enter Matches. It cannot be ended early. Redeem and Unlock keep working.</li>
          <li><b>Self-Exclusion:</b> 6 months or more in which you cannot enter Matches, take Advances or Extend. It cannot be ended early. Redeem and Unlock keep working.</li>
        </ul>
        <p>
          Protections are enforced by {BRAND.name}&apos;s programs for your Account. They cannot stop you using a different Account or wallet, which these Terms forbid.
          If playing is hurting you or someone close to you, stop and talk to a support service in your country.
        </p>
      </Section>

      <Section id="risks" title="Risks you accept">
        <p>
          Read <Link href="/docs/risks">Risks and limits</Link>. In short, you accept that:
        </p>
        <ul>
          <li>{BRAND.name} runs on experimental software. Smart contracts can have bugs, even after review or audit, and could lose some or all of what they hold.</li>
          <li>Staking tokens carry the risk of their own protocol, price, smart contracts, slashing and depeg. Yield is variable and can be zero. Holders of repaid Gemas carry a slash as described under Gemas.</li>
          <li>Some parts are trusted rather than enforced: the issuance price key, the Invite and keeper keys, the program upgrade keys, MagicBlock&apos;s secure environment and LayerZero&apos;s message delivery.</li>
          <li>Third-party services (blockchains, wallets, sign-in, hosting, email, price feeds, staking providers) can fail, change or stop. We are not responsible for them.</li>
          <li>Crypto transactions are final. Prices move. Taxes may apply to you; you alone are responsible for yours.</li>
          <li>Nothing on {BRAND.name} is legal, tax, investment or financial advice.</li>
        </ul>
      </Section>

      <Section id="our-rights" title="Our rights to change and pause">
        <p>
          We may update {BRAND.name}, change fees for new Matches and Advances, list or unlist Games, pause queues, sponsored costs or
          Instant Redeem fills to protect Players or fix a problem, upgrade programs, and stop the service. We will not pause settling or refunding a Match you are in, or Redeem and Unlock. If we change these Terms in a way that matters we will tell you
          in the app or by email, and the new Terms apply from the date shown. If you keep using {BRAND.name} after that, you accept them.
        </p>
      </Section>

      <Section id="ip" title="Our work and yours">
        <p>
          The {BRAND.name} name, logos, art and website belong to {BRAND.companyName} or its licensors. Our open-source code is licensed under its own licence in our repository.
          We give you a limited, revocable, non-transferable right to use {BRAND.name} as these Terms allow. You keep rights in what you post, and you give us a licence to
          show it as part of {BRAND.name} (for example your Profile and share cards). Feedback you send us can be used without obligation to you.
        </p>
      </Section>

      <Section id="disclaimers" title="No warranty">
        <p>
          {BRAND.name} is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the fullest extent the law allows, we give no warranty of any kind, including
          merchantability, fitness for a purpose, accuracy, availability, security or that results, yield, prices or Unlock Estimates will be correct or achieved.
        </p>
      </Section>

      <Section id="liability" title="Limit of liability">
        <p>
          To the fullest extent the law allows, {BRAND.companyName}, its officers, employees, contractors and affiliates are not liable for indirect, incidental, special,
          consequential or punitive damages, or for lost profits, lost yield, lost Gemas or lost tokens, however caused, even if told of the possibility. Our total
          liability for any claim about {BRAND.name} is limited to the greater of the fees you paid us in the 12 months before the claim and US$100. Some places do not allow
          these limits, and then they apply as far as the law permits.
        </p>
      </Section>

      <Section id="indemnity" title="Your responsibility to us">
        <p>
          You will defend and pay back {BRAND.companyName} and its team for claims, losses and costs that come from your breach of these Terms, your breach of law, or your
          use of {BRAND.name}.
        </p>
      </Section>

      <Section id="ending" title="Ending">
        <p>
          You may stop using {BRAND.name} at any time. What you lock stays yours under the Lock&apos;s rules, and Redeem and Unlock stay available as the programs allow.
          We may suspend or end your access to our apps and services at any time, for example for a breach of these Terms or a legal requirement. Sections that by their
          nature should survive, including fair play, risks, liability, indemnity and disputes, survive.
        </p>
      </Section>

      <Section id="law" title="Governing law and disputes">
        <p>
          These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-law rules. Before filing a claim, contact us at{" "}
          {ENTITY.contactEmail} and give us 30 days to resolve it. If we cannot, the state and federal courts located in Delaware have exclusive jurisdiction, and you
          and we consent to them. Claims must be brought within one year of arising, and only on your own behalf, not as a class or group.
        </p>
        {/* Lawyer: decide on binding arbitration and a class-action waiver, and on consumer-law carve-outs per country. */}
      </Section>

      <Section id="general" title="General">
        <p>
          These Terms and the Privacy Policy are the whole agreement between you and us about {BRAND.name}. If a part is unenforceable, the rest stays. Our not enforcing a
          right is not a waiver of it. You may not transfer your rights under these Terms; we may transfer ours. We are not liable for delay or failure caused by
          events beyond our control, including blockchain halts, network congestion, or third-party outages.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          {ENTITY.name}
          <br />
          {ENTITY.address && (
            <>
              {ENTITY.address}
              <br />
            </>
          )}
          {ENTITY.contactEmail}
        </p>
      </Section>
    </LegalPage>
  );
}
