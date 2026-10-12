import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocPage, H2 } from "@/components/docs/prose";
import { AvatarStrip, Shot } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Accounts and sign-in", alternates: { canonical: "/docs/accounts" } };

export default function Page() {
  return (
    <DocPage href="/docs/accounts" hero={<Shot name="account" url="tesoro-fawn.vercel.app/account/…" alt="A Player's public Account page with their record, Gemas won and lost, and Match history" priority caption="A Player's public Account page: what they played, nothing more. Figures here are sample data." />}>
      <H2 id="account">One Account</H2>
      <p>
        Your <b>Account</b> is your single identity on Tesoro. Your Positions, Gemas, Match history and Backings all belong to the Account, not to a
        particular wallet. It holds one address for each chain family: one for Solana and one for Ethereum-style chains (Ethereum and HyperEVM).
      </p>

      <H2 id="sign-in">Signing in</H2>
      <p>You can sign in with:</p>
      <ul>
        <li>
          <b>Email.</b> Tesoro creates a wallet for you, so you can play without installing anything.
        </li>
        <li>
          <b>A wallet you already have.</b> A Solana wallet such as Phantom, or an Ethereum-style wallet such as MetaMask.
        </li>
      </ul>
      <p>
        You do not need to sign in to read these docs, the <Link href="/help">Help page</Link>, the landing page, or anyone&apos;s public Account page.
      </p>

      <H2 id="profile">Your profile</H2>
      <p>Other Players see your profile on Match pages, the Lobby, Backing Requests and the Leaderboard. You can:</p>
      <ul>
        <li>set a <b>display name</b> and pick a <b>gemstone animal picture</b>, or</li>
        <li>show the <b>.sol, .eth or .hl name</b> of a wallet you attach, with a check mark, and use the name&apos;s avatar as your picture.</li>
      </ul>
      <p>
        Tesoro&apos;s pictures are animals cut like gemstones. There are no photos of people, so you are never asked to upload one.
      </p>

      <AvatarStrip />

      <H2 id="public-page">Your public Account page</H2>
      <p>
        Every Account has a page at <code>/account/&lt;key&gt;</code> that anyone can open, signed in or not. It shows only what the Player played:
        how many Matches they won out of how many, the Gemas they won and lost, their Backings, and their Match history. It shows no balances, no
        Positions and nothing they did as a Backer. A Player can also use it to send a Challenge link.
      </p>

      <H2 id="linking">Linking an Ethereum address</H2>
      <p>
        To open a Position on Ethereum or HyperEVM, your Account needs to know which Ethereum address is yours. You sign a short message with that
        address, and the signature is checked on chain, so nobody can claim an address that is not theirs and receive its Position or payouts. The
        app walks you through this the first time. See <Link href="/docs/chains">Chains</Link>.
      </p>

      <Callout kind="note" title="Keep your wallet safe">
        <p>
          Whoever controls your sign-in controls your Account. Tesoro cannot recover a lost wallet or reverse a transaction.
        </p>
      </Callout>
    </DocPage>
  );
}
