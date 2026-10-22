import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal/LegalPage";
import { DataTable } from "@/components/docs/prose";
import { ENTITY } from "@/lib/legal/entity";
import { BRAND } from "@/lib/brand";

// DRAFT PENDING LEGAL REVIEW: written in-house, not yet reviewed by a lawyer. See lib/legal/entity.ts.
const TITLE = "Privacy Policy";
const DESCRIPTION = `What ${BRAND.name} collects, why, who sees it, and your choices.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { title: `${TITLE} · ${BRAND.name}`, description: DESCRIPTION, siteName: BRAND.name, type: "website", images: "/opengraph-image.png" },
  twitter: { card: "summary_large_image", title: `${TITLE} · ${BRAND.name}`, description: DESCRIPTION, images: "/twitter-image.png" },
};

export default function Privacy() {
  return (
    <LegalPage title={TITLE} lede={DESCRIPTION} effective={ENTITY.privacyEffectiveDate}>
      <Section id="who" title="Who we are">
        <p>
          {ENTITY.name}, {ENTITY.form}{ENTITY.address ? `, ${ENTITY.address}` : ""}, runs {BRAND.name} and decides how the data described here is used. This policy explains it. It goes with our{" "}
          <Link href="/terms">Terms of Service</Link>. Questions: {ENTITY.privacyEmail}.
        </p>
      </Section>

      <Section id="public" title="Read this first: blockchains are public">
        <p>
          {BRAND.name} is built on public blockchains. Your wallet addresses, your Locks, Advances, Gemas, Matches, Backings, Season results, and your Profile name and
          picture are written on chain. Anyone can read them, forever, and nobody, including us, can edit or erase them. If someone links an address to your
          identity, they can see everything it has done. Choose your Profile name and picture with that in mind, and never put personal details in them.
        </p>
      </Section>

      <Section id="collect" title="What we collect">
        <DataTable
          head={["Data", "Where it comes from", "Why we use it"]}
          rows={[
            ["Email address", "The waitlist, your Invite, notification settings, or sign-in by email.", "To sign you in, send your Invite and the notices you asked for, and run the waitlist."],
            ["Wallet addresses and on-chain activity", "Your wallets and the blockchains. Public.", "To run your Account: Locks, Gemas, Matches, payouts, Seasons."],
            ["Profile name and picture", "You choose them. Public, kept on chain.", "To show you to other Players."],
            ["Friends", "You add them: Friend requests, your Friend list, your add-me link and Challenges you send Friends.", "To show you your Friends and let you challenge them. Private: only you see your list, and each Friend sees only that you are Friends. We may look at it when we check a cheating report."],
            ["18+ confirmation", "You tell us once, before your first Match.", "To record that you said you are at least 18. Self-declared; we do not check your age."],
            ["Protections and fair-play records", "Your Entry Limit, Break, Self-Exclusion, and signals used to find bots and multiple Accounts.", "To enforce your limits and our fair-play rules."],
            ["Server logs and device data", "Your browser when you use our site: IP address, browser type, pages and times, errors.", `To keep ${BRAND.name} secure and working, stop abuse, and fix bugs.`],
            ["Messages to us", "What you send us.", "To reply and keep a record."],
          ]}
        />
        <p>We do not ask for your name, address, ID documents or payment cards. We do not sell your data.</p>
      </Section>

      <Section id="use" title="How we use it">
        <ul>
          <li>To provide {BRAND.name}: sign-in, Accounts, Matches, redemptions, Seasons and payouts.</li>
          <li>To send Invites, service notices and the notification emails you turned on. You can turn them off.</li>
          <li>To keep {BRAND.name} safe: finding bots, multiple Accounts and cheating, and handling disputes.</li>
          <li>To follow the law and protect our rights.</li>
          <li>To understand how {BRAND.name} is used, so we can improve it, in aggregate.</li>
        </ul>
        <p>
          Where the law asks for a legal basis (for example in the UK and EU), we rely on performing our contract with you, our legitimate interest in running and
          protecting {BRAND.name}, your consent (for example for marketing email), and legal obligations.
        </p>
      </Section>

      <Section id="share" title="Who we share it with">
        <p>We use these services to run {BRAND.name}. Each sees only what it needs, and has its own privacy policy.</p>
        <DataTable
          head={["Provider", "For", "What it sees"]}
          rows={[
            ["Privy", "Sign-in by email or wallet", "Your email or wallet, device and sign-in details."],
            ["Supabase", "Database for the waitlist, notification emails and Friends", "Your email, sign-up details, notification settings and Friends list."],
            ["Resend", "Sending email", "Your email address and the message."],
            ["Vercel", "Hosting our website", "Requests to our site, including your IP address and logs."],
            ["MagicBlock", "Rollups that run Matches, and price feeds", "Wallet addresses and the Match activity sent to its network."],
            ["LayerZero", "Cross-chain messages for Ethereum and HyperEVM Locks", "Wallet addresses and Lock messages, public on chain."],
            ["Pyth and MagicBlock price feeds", "Prices for Advances", "Nothing about you."],
            ["Staking providers (Jito, Lido, Kinetiq)", "Staking tokens for Locks", "On-chain activity of the Lock, public."],
            ["Blockchains and wallets", "Everything on chain", "Public by design."],
          ]}
        />
        <p>
          We may also share data with professional advisers, with a buyer if {BRAND.companyName} is sold or merged, and with authorities when the law requires it or to
          protect Players and {BRAND.name}. Providers may change as {BRAND.name} grows; we will update this list.
        </p>
      </Section>

      <Section id="transfers" title="Where it goes">
        <p>
          {BRAND.companyName} is in the United States, and so are many of our providers. If you are elsewhere, your data will be processed in the United States and other
          countries that may have different data laws. Where required, we use legal safeguards for these transfers.
        </p>
      </Section>

      <Section id="keep" title="How long we keep it">
        <p>
          On-chain data stays on chain. We keep your email while you are on the waitlist or have an Account with notifications on, and delete it within a reasonable
          time after you ask or unsubscribe. We keep server logs for a short period, and fair-play, Protection and 18+ records for as long as your Account exists and
          afterwards as long as the law or a dispute needs. Test mode data may be reset at any time.
        </p>
      </Section>

      <Section id="rights" title="Your choices and rights">
        <ul>
          <li>Unsubscribe from any email with its link, or change notification settings in the app.</li>
          <li>Ask us for a copy of the personal data we hold about you, to correct it, or to delete it. We cannot change or erase what is on a blockchain.</li>
          <li>Depending on where you live (for example California, the UK or the EU), you may also have the right to object to or limit some uses, to move your data, and to complain to your data regulator. We do not sell or share personal data for advertising.</li>
        </ul>
        <p>Write to {ENTITY.privacyEmail}. We may need to check it is you before we act.</p>
      </Section>

      <Section id="security" title="Security">
        <p>
          We use reasonable measures to protect off-chain data, and we keep secrets in separate keys. No system is perfectly secure. You are responsible for your own
          wallets and keys, and we will never ask you for your seed phrase or private key.
        </p>
      </Section>

      <Section id="age" title="Age">
        <p>{BRAND.name} is for people aged {ENTITY.minAge} and over. We do not knowingly collect data from anyone younger. If you think a child has given us data, write to us and we will delete it.</p>
      </Section>

      <Section id="cookies" title="Cookies and similar tools">
        <p>
          We and our sign-in provider use cookies and browser storage that are needed to keep you signed in, remember your theme and settings, and keep the site
          secure. We do not use them for advertising.
        </p>
      </Section>

      <Section id="changes" title="Changes">
        <p>We may update this policy. We will change the date at the top and, for changes that matter, tell you in the app or by email.</p>
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
          {ENTITY.privacyEmail}
        </p>
      </Section>
    </LegalPage>
  );
}
