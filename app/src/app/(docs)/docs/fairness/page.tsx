import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocPage, H2 } from "@/components/docs/prose";
import { Eye, EyeOff, Gamepad2, Calculator, Scale } from "lucide-react";
import { Pipeline } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Fairness and privacy", alternates: { canonical: "/docs/fairness" } };

export default function Page() {
  return (
    <DocPage href="/docs/fairness" hero={<Pipeline label="From a hidden start to a settled result" items={[
  { icon: EyeOff, tone: "violet", title: "Sealed", body: "Pieces, deck and positions are made inside a private environment." },
  { icon: Gamepad2, tone: "sapphire", title: "Played", body: "Your moves stay hidden from your opponent while the Match runs." },
  { icon: Eye, tone: "violet", title: "Revealed", body: "Both runs close, or a showdown happens. Then it is public." },
  { icon: Calculator, tone: "amber", title: "Replayed", body: "The game program works out the result itself." },
  { icon: Scale, tone: "emerald", title: "Settled", body: "One transaction on Solana moves the Gemas." },
]} />}>
      <p>
        A head-to-head game is only fair if neither Player can see what they should not, and the result is calculated by rules both Players can
        check. This page says how Tesoro does that, and where you still have to trust someone.
      </p>

      <H2 id="no-game-servers">Games run on chain, not on our servers</H2>
      <p>
        Each Game is a program on Solana, not a server owned by Tesoro or by the Game&apos;s maker. The program holds the Match state and works out the
        result, and only the Game&apos;s registered program can settle a Match&apos;s Pot. Nobody at Tesoro types in a winner.
      </p>

      <H2 id="hidden-information">Hidden information stays hidden</H2>
      <ul>
        <li><b>Hold&apos;em.</b> The deck and each Player&apos;s hole cards are private. Your cards are readable only by you; cards become public only at a showdown.</li>
        <li><b>Block Puzzle.</b> The pieces for a Match are generated at random and are not visible to anyone, including you, until your own run begins. Your moves stay hidden until both runs are closed.</li>
        <li><b>Trading Duel.</b> Each Player&apos;s picks stay hidden until their column locks, ten seconds before the line reaches it, and both full sets of picks are published afterwards.</li>
      </ul>
      <p>
        This is done with MagicBlock&apos;s private environment, which runs on secure hardware. Randomness comes from a verifiable random-number service
        and, in Hold&apos;em, from secrets both Players contribute, so neither a Player nor Tesoro can steer the shuffle.
      </p>

      <H2 id="results">Results you can check</H2>
      <ul>
        <li>Your Block Puzzle score is the game program&apos;s replay of your moves. There is no way to submit a score, and an illegal move is rejected.</li>
        <li>The settlement of every Match is a transaction on Solana. Anyone can open the Match page and see the result, the Fees and who got what.</li>
        <li>Time limits, such as a Hold&apos;em turn or a Block Puzzle run, are enforced by the program, and anyone can trigger a timeout or a refund; you do not have to wait for Tesoro.</li>
      </ul>

      <H2 id="what-you-trust">What you still have to trust</H2>
      <p>No system removes trust completely. For hidden information, you are trusting:</p>
      <ul>
        <li>
          <b>MagicBlock&apos;s secure hardware and its operator.</b> If that failed, hidden cards, pieces or positions could be seen early. A Player cannot
          see them, but the environment&apos;s operator could in principle.
        </li>
        <li><b>The random-number service</b> to deliver honest randomness.</li>
      </ul>
      <p>
        The rest of the trust assumptions, including the price feed, cross-chain messaging and admin keys, are listed in{" "}
        <Link href="/docs/risks">Risks and limits</Link>.
      </p>

      <Callout kind="warn" title="Reviewed internally, not externally">
        <p>
          The programs have had two internal reviews and no external audit. The first review found a way for a Player to commit a forged result, which
          was fixed before submission. The details are in <Link href="/docs/developers/security">Security</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
