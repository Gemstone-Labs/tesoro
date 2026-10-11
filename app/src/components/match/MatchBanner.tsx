import Image from "next/image";
import Link from "next/link";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { CheckIcon, MinusIcon, XIcon } from "@/components/ui";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { amountText, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./match-banner.css";

const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;

/**
 * One finished Match on a Player's Account, as a banner over the Game's hero art: the result as a
 * poster word, the two Players face to face (with Block Puzzle scores), the Gema change on a glass chip.
 * Every small line sits on the dark side of the art or on a plate. The banner opens the Match; the
 * opponent's seat leads to their Account (a separate link above it, never nested).
 * `player` is the Account whose page this is; `backing` is the Backing line under the entry.
 */
export function MatchBanner({ r, player, now, backing }: { r: HistoryRow; player: string; now: number; backing?: string | null }) {
  const res = RESULT[r.result];
  const tone = r.delta > 0 ? "won" : r.delta < 0 ? "lost" : "even";
  const figure = r.delta === 0 && r.result !== "lost" ? amountText(r) : `${r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}${fmtGemas(Math.abs(r.delta))} Gemas`;
  return (
    <article className={`cut cut-card mb ${r.result}`}>
      <span className="mb-art">
        <Image src={art.hero[r.game]} alt="" fill sizes="(max-width: 700px) 100vw, 980px" />
      </span>
      <Link href={`/play/match/${r.id}`} className="mb-hit" aria-label={`See this ${GAME_NAMES[r.game]} Match: ${res.text}, ${figure}`} />
      <div className="mb-word">
        <span className="mb-kick">
          {GAME_NAMES[r.game]} · {ago(r.at, now)}
        </span>
        <b>{res.text}</b>
        <small>
          Entry {fmtGemas(r.entry)}
          {backing && <> · {backing}</>}
        </small>
      </div>
      <div className="mb-face">
        <Seat account={player} score={r.scores?.[0]} lit={r.result === "won"} dim={r.result === "lost"} />
        <span className="mb-vs" aria-hidden="true">vs</span>
        {r.opp ? (
          <AccountLink account={r.opp} className="mb-seat-link">
            <Seat account={r.opp} score={r.scores?.[1]} lit={r.result === "lost"} dim={r.result === "won"} />
          </AccountLink>
        ) : (
          <span className="mb-seat empty">
            <span className="mb-av" />
            <span className="mb-plate">No opponent</span>
          </span>
        )}
      </div>
      <span className={`cut cut-chip mb-fig ${tone}`}>
        <res.Icon aria-hidden="true" />
        <b className="tnum">{figure}</b>
      </span>
    </article>
  );
}

function Seat({ account, score, lit, dim }: { account: string; score?: number; lit: boolean; dim: boolean }) {
  return (
    <span className={`mb-seat${lit ? " lit" : ""}${dim ? " dim" : ""}`}>
      <PlayerAvatar account={account} size={52} className="mb-av" />
      <span className="mb-plate">
        <PlayerName account={account} />
        {score !== undefined && <b className="tnum">{fmtGemas(score)}</b>}
      </span>
    </span>
  );
}
