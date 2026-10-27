"use client";

import Link from "next/link";
import { GemaMark, GemaUsd } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { ago } from "@/lib/catalogue";
import { useRecentSettled } from "@/lib/chain/useRecentSettled";
import { scoreLine, type SettledMatch } from "@/lib/chain/settled";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";

/** Recent wins, settled on Solana devnet, as one slow strip under the hero. Pauses on hover and focus. */
export function LiveWins() {
  const { matches, loading } = useRecentSettled(12);
  const { snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const pending = loading && matches.length === 0;
  if (!pending && matches.length === 0) return null;

  const item = (m: SettledMatch, copy: boolean) => (
    <li key={`${copy ? "c" : "o"}${m.id.toString()}`} aria-hidden={copy || undefined}>
      <Link href={`/play/match/${m.id.toString()}`} tabIndex={copy ? -1 : undefined}>
        <PlayerAvatar className="lw-av" account={m.winner} size={28} />
        <b>{m.winner === me ? "You" : <PlayerName account={m.winner} />}</b>
        <span>won</span>
        <strong>
          <GemaMark size={15} />
          {fmtGemas(m.payout)}
          <GemaUsd value={m.payout} />
        </strong>
        <span>
          {GAME_NAMES[m.game]}
          {scoreLine(m.scores) && ` ${scoreLine(m.scores)}`} · {ago(m.at)}
        </span>
      </Link>
    </li>
  );

  return (
    <section className="cut cut-card live-wins" aria-label="Recent wins" aria-busy={pending || undefined}>
      <span className="live-tag">
        <i className="live-dot" aria-hidden="true" />
        Live wins
      </span>
      <div className="lw-viewport">
        {pending ? (
          <div className="lw-placeholders" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="lw-placeholder skel">
                <span className="cut cut-btn lw-av skel-av" />
                <span className="skel-line" style={{ width: 64 }} />
                <span className="skel-line lg" style={{ width: 48 }} />
              </div>
            ))}
          </div>
        ) : <ul className="lw-track" style={{ ["--dur" as string]: `${Math.max(36, matches.length * 6)}s` }}>
          {matches.map((m) => item(m, false))}
          {matches.map((m) => item(m, true))}
        </ul>}
      </div>
    </section>
  );
}
