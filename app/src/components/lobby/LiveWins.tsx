"use client";

import Image from "next/image";
import Link from "next/link";
import { GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { avatarFor } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { shortKey } from "@/lib/chain/useBackingBoard";
import { useRecentSettled } from "@/lib/chain/useRecentSettled";
import type { SettledMatch } from "@/lib/chain/settled";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";

/** Recent wins, settled on Solana devnet, as one slow strip under the hero; each leads to the winner's Account. Pauses on hover and focus. */
export function LiveWins() {
  const { matches } = useRecentSettled(12);
  const { snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  if (matches.length === 0) return null;

  const item = (m: SettledMatch, copy: boolean) => (
    <li key={`${copy ? "c" : "o"}${m.id.toString()}`} aria-hidden={copy || undefined}>
      <Link href={`/account/${m.winner}`} tabIndex={copy ? -1 : undefined}>
        <Image className="lw-av" src={avatarFor(m.winner)} alt="" width={28} height={28} />
        <b>{m.winner === me ? "You" : shortKey(m.winner)}</b>
        <span>won</span>
        <strong>
          <GemaMark size={15} />
          {fmtGemas(m.payout)}
        </strong>
        <span>
          {GAME_NAMES[m.game]}
          {m.scores && ` ${m.scores[0]}–${m.scores[1]}`} · {ago(m.at)}
        </span>
      </Link>
    </li>
  );

  return (
    <section className="cut cut-card live-wins" aria-label="Recent wins on Solana devnet">
      <span className="live-tag">
        <i className="live-dot" aria-hidden="true" />
        Live wins
      </span>
      <div className="lw-viewport">
        <ul className="lw-track" style={{ ["--dur" as string]: `${Math.max(36, matches.length * 6)}s` }}>
          {matches.map((m) => item(m, false))}
          {matches.map((m) => item(m, true))}
        </ul>
      </div>
    </section>
  );
}
