import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal/LegalPage";
import { ENTITY } from "@/lib/legal/entity";

// DRAFT PENDING LEGAL REVIEW: written in-house, not yet reviewed by a lawyer. See lib/legal/entity.ts.
const TITLE = "Terms of Service";
const DESCRIPTION = "The rules for using Tesoro, from Gemstone Labs, Inc.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: { title: `${TITLE} · Tesoro`, description: DESCRIPTION, siteName: "Tesoro", type: "website", images: "/opengraph-image.png" },
  twitter: { card: "summary_large_image", title: `${TITLE} · Tesoro`, description: DESCRIPTION, images: "/twitter-image.png" },
};

export default function Terms() {
  return (
    <LegalPage title={TITLE} lede={DESCRIPTION}>
      <Section id="who" title="Who we are and what these Terms cover">
        <p>
          Tesoro is made and run by {ENTITY.name}, {ENTITY.form} (&ldquo;Gemstone Labs&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), {ENTITY.address}. These Terms are
          the agreement between you and Gemstone Labs for the Tesoro website, apps, smart contracts and related services (together, &ldquo;Tesoro&rdquo;). By
          signing in, entering a Match or otherwise using Tesoro you agree to them and to our <Link href="/privacy">Privacy Policy</Link>. If you do not agree,
          do not use Tesoro.
        </p>
        <p>
          Words with capital letters, such as Position, Principal, Advance, Gema, Source, Debt, Match, Pot and Season, mean what they mean in the{" "}
          <Link href="/docs">Docs</Link>. The Docs explain how Tesoro works; these Terms are the binding rules. If they differ, these Terms win.
        </p>
      </Section>

      <Section id="eligibility" title="Who may use Tesoro">
        <ul>
          <li>You must be at least {ENTITY.minAge} years old, and old enough to enter binding contracts where you live. We ask you to confirm this, and we rely on what you tell us.</li>
          <li>You must not use Tesoro if the law where you live forbids it, or forbids staking products, skill games or prize contests. No country is blocked today, so you alone are responsible for knowing and following the law that applies to you. We may restrict or end availability in any place at any time, with or without notice.</li>
          <li>You must not use Tesoro if you are on a sanctions list, or act for someone who is.</li>
          <li>At mainnet launch, creating an Account needs an Invite, one for each waitlist member, until we open Tesoro to everyone. An Invite is for one person and cannot be sold or passed on.</li>
          <li>One person, one Account. Do not create more than one, and do not use someone else&apos;s.</li>
        </ul>
      </Section>

      <Section id="test-mode" title="Test mode">
        <p>
          While Tesoro runs on test networks (&ldquo;test mode&rdquo;), yield is simulated and speeded up, and Gemas, Positions and anything else shown have
          no real value. Nothing you hold in test mode can be exchanged for money, and we may reset or remove test mode balances and data at any time. These
          Terms apply to test mode too, except the parts that only make sense for real assets.
        </p>
      </Section>

      <Section id="accounts" title="Your Account and wallets">
        <p>
          You sign in with an email or a wallet, through our sign-in provider. Your Account holds your Positions, Gemas, Match history and Backings, and
          lives on public blockchains. You are responsible for your email, your wallets, your keys and everything done with them. We cannot recover keys,
          reverse transactions or restore access you lost. Tell us quickly at {ENTITY.contactEmail} if you think your access was compromised.
        </p>
        <p>
          Your Profile name and picture are public and kept on chain. Do not use a name or picture that is unlawful, hateful, misleading, or that
          impersonates someone. We may hide or remove them in our app.
        </p>
      </Section>

      <Section id="positions" title="Positions, Principal and Advances">
        <ul>
          <li>
            A <b>Position</b> locks a staking token you own in Tesoro&apos;s programs or vaults. We do not take ownership of it and we never play with your
            Principal: no Match entry, fee or Backing draws on it, and it never pays Debt.
          </li>
          <li>
            An <b>Advance</b> issues you Gemas upfront against the yield your Position is projected to earn over the Horizon you choose. It is not a loan
            or a line of credit. It creates <b>Debt</b>, in the Position&apos;s own asset, that only the Position&apos;s accrued yield (or the return of Gemas
            Sourced from it) can reduce. The Position stays locked until its Debt is zero.
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
            We may change which staking token and provider (for example Jito, Lido or Kinetiq) new Positions use. Open Positions keep the token they started with.
          </li>
          <li>
            We take a <b>Yield Fee</b> of 20% of the yield a Position earns, before it counts toward Debt, redemption or free yield. We never charge it on Principal.
          </li>
        </ul>
      </Section>

      <Section id="gemas" title="Gemas">
        <p>
          A Gema is the play unit across Tesoro. It is worth $0.01 at the moment it is issued. It is a claim on the accrued yield of its Source, not a
          currency, a security, a deposit or a stored value account with us, and it is not insured. Gemas are equal at the table but not at redemption: what a
          Gema redeems for follows its Source asset and the yield actually earned.
        </p>
        <ul>
          <li><b>Redeem</b> turns Gemas into their Source asset, only as far as the Source Position&apos;s yield has actually accrued. Winning Gemas never shortens your own lock.</li>
          <li>
            <b>Instant Redeem</b> turns Gemas you won into their Source asset before that yield has landed, for 75% of their value, and only while Tesoro&apos;s
            Treasury for that asset holds enough to pay. The other 25% is Tesoro&apos;s fee. When the Treasury is short, the request is refused.
          </li>
          <li>Won Gemas can wait a long time, or without an end date, if the yield of the loser&apos;s Source collapses.</li>
          <li>Gemas can be used to play and redeem as described here. They cannot be sold to or bought from us for money.</li>
        </ul>
      </Section>

      <Section id="matches" title="Matches, entries and fees">
        <p>
          A Match is a head-to-head contest of skill between two Players with equal Gema entries, settled once. The winner takes the Pot minus fees. A draw, an
          abandoned Match or a no-show refunds both entries. Some Games, such as Hold&apos;em, include chance within a hand. You can lose everything you enter.
        </p>
        <ul>
          <li>Fees on every Pot are fixed when the Match opens: a Platform Fee of 2%, a Studio Fee of 3% (set by the Game&apos;s Studio) and a Leaderboard Fee of 1%. A draw or refund pays none.</li>
          <li>Results are decided by the Game&apos;s program. For Games with a shared Seed, a score counts only as the server&apos;s replay of your inputs.</li>
          <li>You are playing other people, not us. We do not guarantee that an opponent will be found, will finish, or will play fairly.</li>
          <li>Tesoro is not a casino, a sportsbook or a lottery. We do not offer games against the house.</li>
        </ul>
      </Section>

      <Section id="backing" title="Backing">
        <p>
          A Backing is an agreement between a Backer and a Player, accepted by both, in which the Backer funds the Player&apos;s full entry into one Match. On
          a win the Backer&apos;s entry is returned first and the remainder is split as the Offer said. It cannot be revoked once the Match starts. Only the
          Backer bears a loss. We are not a party to the Backing, do not advise on it, and do not guarantee any return. Back only what you can lose.
        </p>
      </Section>

      <Section id="seasons" title="Seasons and the Leaderboard">
        <p>
          Each Season runs one week, Monday 00:00 UTC to the next Monday. Wins earn Points as the Docs describe, with a cap on Points from repeat wins against the
          same opponent. The Leaderboard Pool, funded by Leaderboard Fees, is paid to top Players 48 hours after a Season ends. In that window we may review the
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
          <li>use stolen, borrowed or illegally obtained funds, or use Tesoro to launder money or evade sanctions;</li>
          <li>harass others, or misuse a Profile, a Challenge link or a share card.</li>
        </ul>
        <p>
          If we reasonably believe you broke these rules, we may void your Matches, withhold or take back payouts and Points, disqualify you from a Season, restrict
          or end your access in our apps, and report you where the law requires. Smart contracts hold your Principal; we cannot take it, but we can stop you using our
          apps, queues and payouts.
        </p>
      </Section>

      <Section id="protections" title="Protections">
        <p>Tesoro gives you tools to stay in control. Use them early.</p>
        <ul>
          <li><b>Entry Limit:</b> your own cap on the Gemas you may enter into Matches in any 7 days. Lowering applies at once; raising applies 24 hours later.</li>
          <li><b>Break:</b> 1 day to 6 weeks in which you cannot enter Matches. It cannot be ended early. Redeem and Unlock keep working.</li>
          <li><b>Self-Exclusion:</b> 6 months or more in which you cannot enter Matches, take Advances or Extend. It cannot be ended early. Redeem and Unlock keep working.</li>
        </ul>
        <p>
          Protections are enforced by Tesoro&apos;s programs for your Account. They cannot stop you using a different Account or wallet, which these Terms forbid.
          If playing is hurting you or someone close to you, stop and talk to a support service in your country.
        </p>
      </Section>

      <Section id="risks" title="Risks you accept">
        <p>
          Read <Link href="/docs/risks">Risks and limits</Link>. In short, you accept that:
        </p>
        <ul>
          <li>Tesoro runs on experimental software. Smart contracts can have bugs, even after review or audit, and could lose some or all of what they hold.</li>
          <li>Staking tokens carry the risk of their own protocol, price, smart contracts, slashing and depeg. Yield is variable and can be zero.</li>
          <li>Some parts are trusted rather than enforced: the issuance price key, the Invite and keeper keys, the program upgrade keys, MagicBlock&apos;s secure environment and LayerZero&apos;s message delivery.</li>
          <li>Third-party services (blockchains, wallets, sign-in, hosting, email, price feeds, staking providers) can fail, change or stop. We are not responsible for them.</li>
          <li>Crypto transactions are final. Prices move. Taxes may apply to you; you alone are responsible for yours.</li>
          <li>Nothing on Tesoro is legal, tax, investment or financial advice.</li>
        </ul>
      </Section>

      <Section id="our-rights" title="Our rights to change and pause">
        <p>
          We may update Tesoro, change fees for new Matches and Advances, add or remove Games, pause queues, settlements or
          redemptions to protect Players or fix a problem, upgrade programs, and stop the service. If we change these Terms in a way that matters we will tell you
          in the app or by email, and the new Terms apply from the date shown. If you keep using Tesoro after that, you accept them.
        </p>
      </Section>

      <Section id="ip" title="Our work and yours">
        <p>
          The Tesoro name, logos, art and website belong to Gemstone Labs or its licensors. Our open-source code is licensed under its own licence in our repository.
          We give you a limited, revocable, non-transferable right to use Tesoro as these Terms allow. You keep rights in what you post, and you give us a licence to
          show it as part of Tesoro (for example your Profile and share cards). Feedback you send us can be used without obligation to you.
        </p>
      </Section>

      <Section id="disclaimers" title="No warranty">
        <p>
          Tesoro is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the fullest extent the law allows, we give no warranty of any kind, including
          merchantability, fitness for a purpose, accuracy, availability, security or that results, yield, prices or Unlock Estimates will be correct or achieved.
        </p>
      </Section>

      <Section id="liability" title="Limit of liability">
        <p>
          To the fullest extent the law allows, Gemstone Labs, its officers, employees, contractors and affiliates are not liable for indirect, incidental, special,
          consequential or punitive damages, or for lost profits, lost yield, lost Gemas or lost tokens, however caused, even if told of the possibility. Our total
          liability for any claim about Tesoro is limited to the greater of the fees you paid us in the 12 months before the claim and US$100. Some places do not allow
          these limits, and then they apply as far as the law permits.
        </p>
      </Section>

      <Section id="indemnity" title="Your responsibility to us">
        <p>
          You will defend and pay back Gemstone Labs and its team for claims, losses and costs that come from your breach of these Terms, your breach of law, or your
          use of Tesoro.
        </p>
      </Section>

      <Section id="ending" title="Ending">
        <p>
          You may stop using Tesoro at any time. Your Principal stays yours under the Position&apos;s rules, and Redeem and Unlock stay available as the programs allow.
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
          These Terms and the Privacy Policy are the whole agreement between you and us about Tesoro. If a part is unenforceable, the rest stays. Our not enforcing a
          right is not a waiver of it. You may not transfer your rights under these Terms; we may transfer ours. We are not liable for delay or failure caused by
          events beyond our control, including blockchain halts, network congestion, or third-party outages.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          {ENTITY.name}
          <br />
          {ENTITY.address}
          <br />
          {ENTITY.contactEmail}
        </p>
      </Section>
    </LegalPage>
  );
}
