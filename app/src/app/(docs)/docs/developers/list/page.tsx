import type { Metadata } from "next";
import { ApplyForm } from "@/components/docs/ApplyForm";
import { DocPage, H2 } from "@/components/docs/prose";

export const metadata: Metadata = { title: "List your Game", alternates: { canonical: "/docs/developers/list" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/list">
      <p>
        Any Game can register with Tesoro. A <b>listed</b> Game also earns Points, takes part in Backed Matches, gets its Studio Fee paid first and has its
        Players’ transaction costs covered.
      </p>

      <H2 id="how">How listing works</H2>
      <ol>
        <li>
          <b>Apply.</b> It’s free. Fill in the form below with the address of your Game’s program.
        </li>
        <li>
          <b>Get accepted.</b> We review the Game and email you.
        </li>
        <li>
          <b>Pay $500 a year.</b> On chain or by invoice, your choice. The listing lasts for the year you paid.
        </li>
        <li>
          <b>Go live.</b> We list the exact version of your program that we reviewed.
        </li>
      </ol>

      <H2 id="upgrades">When you upgrade</H2>
      <p>
        Upgrading your program takes your Game off the list until we approve the new version. Matches already under way finish normally. Tell us when
        you ship and we’ll review it again.
      </p>

      <H2 id="apply">Apply</H2>
      <ApplyForm />
    </DocPage>
  );
}
