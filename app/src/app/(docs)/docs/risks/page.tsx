import type { Metadata } from "next";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { Handshake, ShieldCheck } from "lucide-react";
import { Compare } from "@/components/docs/visual";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Risks and limits", alternates: { canonical: "/docs/risks" } };

export default function Page() {
  return (
    <DocPage href="/docs/risks" hero={<Compare
  left={{ title: "Trusted, not enforced", icon: Handshake, tone: "amber", items: [`The issuance price, from a ${BRAND.name}-controlled key`, "Hidden information, kept by MagicBlock's secure environment", "Cross-chain messages, delivered by LayerZero", "Program upgrades, by one admin key"] }}
  right={{ title: "Enforced by the programs", icon: ShieldCheck, tone: "emerald", items: ["What you lock is never entered into a Match or used to pay back an Advance", "A Match is settled exactly once, by the Game's own program", "Fees are fixed when the Match opens", "Anyone can trigger a timeout or a refund"] }}
/>}>
      <Callout kind="warn" title="Read this first">
        <p>When you lock crypto, it stays locked until your Advance is paid back, and that can take longer than the estimate. Only lock what you won&apos;t need for a while. The rest of this page explains the risks.</p>
      </Callout>

      <H2 id="prices">Prices come from a trusted key</H2>
      <p>
        The price used to size an Advance is written by a {BRAND.name}-controlled key from public price sources. A wrong price would issue the wrong number
        of Gemas. It is used once, at issuance, and never again.
      </p>

      <H2 id="principal">What &ldquo;what you lock is never played&rdquo; means, and does not</H2>
      <p>
        It means that no Match entry, Fee (including the Yield Fee, which is taken from Gemas when they are cashed out) or Backing ever draws on what you lock, and that it never pays back an Advance. The ledger is built and tested so
        that nothing reads your Locked amount after an Advance is sized. It does not mean what you lock is protected or risk-free. It is still:
      </p>
      <ul>
        <li><b>Locked</b> until the Advance is paid back. If the staking token&apos;s yield slows, the lock lasts longer. The Unlock Estimate is an estimate, never a promise.</li>
        <li><b>Exposed to the staking token itself:</b> its price, its protocol and its smart contracts.</li>
        <li><b>Held by upgradeable programs.</b> A single admin key can upgrade every program today, with no multisig and no timelock.</li>
      </ul>

      <H2 id="economic">Limits of the model</H2>
      <ul>
        <li><b>Won Gemas wait for real yield.</b> If a loser&apos;s staking yield collapses, the Gemas you won from them stay pending with no end date. This is by design.</li>
        <li><b>Instant Redeem is an order {BRAND.name} fills.</b> It pays from what {BRAND.name} can spend for that asset, which excludes the Leaderboard Pool&apos;s share and what unlocked Locks are owed. {BRAND.name} may fill in full, in part or not at all; you can cancel an unfilled order, and you can always wait for a normal Redeem instead.</li>
        <li><b>Gemas are claims on a staking token.</b> If the token is slashed, Gemas that had already been repaid lose value with it, as if you held the token yourself. {BRAND.name} does not insure holders and keeps no cushion for it.</li>
        <li><b>Fees are repaid first.</b> The Platform, Studio and Leaderboard Fee Gemas of an Advance are repaid before other Gemas of it, and Gemas added by an Extend last. This changes who waits, never what you can already Redeem.</li>
        <li><b>Unlisted Games.</b> A Game {BRAND.name} has not listed, or whose code changed after listing, earns no Points, gets no sponsored costs and cannot be Backed. Its Studio can still hold a Match for at most 7 days before a refund is possible.</li>
        <li><b>Sponsored costs can pause.</b> {BRAND.name} pays network costs in Listed Games from a budget. If it is spent, new Matches pause until you pay your own costs or it is refilled; exits keep working.</li>
        <li><b>You can lose your entry.</b> Every Match is a contest of skill against another Player, and you can lose what you enter. A Backer can lose the whole entry they fund.</li>
        <li><b>Skill is not luck-free.</b> Block Puzzle shares the same pieces between Players, but Hold&apos;em has chance in every hand.</li>
      </ul>

      <H2 id="trust">Who you trust</H2>
      <DataTable
        head={["Who", "Trusted for", "If it fails"]}
        rows={[
          ["The price key", "The issuance price of an Advance.", "A wrong price mis-sizes an Advance at issuance."],
          ["MagicBlock's secure environment", "Keeping hidden cards, pieces and positions hidden.", "Hidden information could be seen early."],
          ["LayerZero's verification network", "Delivering cross-chain messages truthfully.", "A false message could report false yield. A vault still pays out no more than the yield it has earned."],
          ["The admin key", `Listing Games, setting fees (Platform, Yield and Instant Redeem), filling Instant Redeem orders, funding ${BRAND.name}&apos;s holdings, upgrading programs.`, "A single key can change the rules or the programs."],
          ["The keeper", "Liveness only: relaying messages, expiring offers, publishing the price. SOL Lock yield needs no keeper: it is computed when you use it.", "If it stops, anyone can send the same transactions, but things go slower."],
        ]}
      />

      <H2 id="legal">Legal</H2>
      <p>
        Rules about skill games, prizes, staking products and Backing differ by country
        and region, and may restrict what you can do or whether you can use {BRAND.name} at all. Nothing in these docs is legal or financial advice, and
        you are responsible for following the rules where you live.
      </p>
    </DocPage>
  );
}
