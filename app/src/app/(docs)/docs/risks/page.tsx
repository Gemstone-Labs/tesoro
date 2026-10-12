import type { Metadata } from "next";
import { Callout, DataTable, DocPage, H2 } from "@/components/docs/prose";
import { Handshake, ShieldCheck } from "lucide-react";
import { Compare } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Risks and limits", alternates: { canonical: "/docs/risks" } };

export default function Page() {
  return (
    <DocPage href="/docs/risks" hero={<Compare
  left={{ title: "Trusted, not enforced", icon: Handshake, tone: "amber", items: ["The issuance price, from a Tesoro-controlled key", "Hidden information, kept by MagicBlock's secure environment", "Cross-chain messages, delivered by LayerZero", "Program upgrades, by one admin key"] }}
  right={{ title: "Enforced by the programs", icon: ShieldCheck, tone: "emerald", items: ["Principal is never entered into a Match or used to pay Debt", "A Match is settled exactly once, by the Game's own program", "Fees are fixed when the Match opens", "Anyone can trigger a timeout or a refund"] }}
/>}>
      <Callout kind="warn" title="Read this first">
        <p>Tesoro runs on smart contracts. Read this page before you lock anything you are not ready to lose access to for a while.</p>
      </Callout>

      <H2 id="prices">Prices come from a trusted key</H2>
      <p>
        The price used to size an Advance is written by a Tesoro-controlled key from public price sources. A wrong price would issue the wrong number
        of Gemas. It is used once, at issuance, and never again.
      </p>

      <H2 id="principal">What &ldquo;Principal is never played&rdquo; means, and does not</H2>
      <p>
        It means that no Match entry, Fee or Backing ever draws on your Principal, and that Principal never pays Debt. The ledger is built and tested so
        that nothing reads Principal after an Advance is sized. It does not mean your Principal is protected or risk-free. It is still:
      </p>
      <ul>
        <li><b>Locked</b> until the Debt is repaid. If the staking token&apos;s yield slows, the lock lasts longer. The Unlock Estimate is an estimate, never a promise.</li>
        <li><b>Exposed to the staking token itself:</b> its price, its protocol and its smart contracts.</li>
        <li><b>Held by upgradeable programs.</b> A single admin key can upgrade every program today, with no multisig and no timelock.</li>
      </ul>

      <H2 id="economic">Limits of the model</H2>
      <ul>
        <li><b>Won Gemas wait for real yield.</b> If a loser&apos;s staking yield collapses, the Gemas you won from them stay pending with no end date. This is by design.</li>
        <li><b>Many small Sources.</b> An entry draws on at most 8 Sources. If your Gemas are spread over more, redeem some small balances first.</li>
        <li><b>You can lose your entry.</b> Every Match is a contest of skill against another Player, and you can lose what you enter. A Backer can lose the whole entry they fund.</li>
        <li><b>Skill is not luck-free.</b> Block Puzzle shares the same pieces between Players, but Hold&apos;em has chance in every hand.</li>
      </ul>

      <H2 id="trust">Who you trust</H2>
      <DataTable
        head={["Who", "Trusted for", "If it fails"]}
        rows={[
          ["The price key", "The issuance price of an Advance.", "A wrong price mis-sizes an Advance at issuance."],
          ["MagicBlock's secure environment", "Keeping hidden cards, pieces and positions hidden.", "Hidden information could be seen early."],
          ["LayerZero's verification network", "Delivering cross-chain messages truthfully.", "A false message could report false yield. A vault still pays out no more than the yield it has accrued."],
          ["The admin key", "Registering Games, setting fees, upgrading programs.", "A single key can change the rules or the programs."],
          ["The keeper", "Liveness only: cranking yield, relaying messages, expiring offers.", "If it stops, anyone can send the same transactions, but things go slower."],
        ]}
      />

      <H2 id="legal">Legal</H2>
      <p>
        Rules about skill games, prizes, staking products and Backing differ by country
        and region, and may restrict what you can do or whether you can use Tesoro at all. Nothing in these docs is legal or financial advice, and
        you are responsible for following the rules where you live.
      </p>
    </DocPage>
  );
}
