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

/** An older finished Match as one compact row: game, result (icon + word), opponent, Gema change, time. The row opens the Match; the opponent leads to their Account. */
export function MatchRow({ r, now }: { r: HistoryRow; now: number }) {
  const res = RESULT[r.result];
  const tone = r.delta > 0 ? "won" : r.delta < 0 ? "lost" : "even";
  const figure = r.delta === 0 && r.result !== "lost" ? amountText(r) : `${r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}${fmtGemas(Math.abs(r.delta))}`;
  return (
    <article className={`cut cut-card mr ${r.result}`}>
      <Link href={`/play/match/${r.id}`} className="mr-hit" aria-label={`See this ${GAME_NAMES[r.game]} Match: ${res.text}, ${figure}`} />
      <Image src={art.thumb[r.game]} alt={GAME_NAMES[r.game]} width={28} height={28} className="mr-game" />
      <span className="mr-res">
        <res.Icon aria-hidden="true" />
        {res.text}
      </span>
      {r.opp ? (
        <AccountLink account={r.opp} className="mr-opp">
          <PlayerAvatar account={r.opp} size={26} className="mb-av" />
          <PlayerName account={r.opp} />
        </AccountLink>
      ) : (
        <span className="mr-opp">No opponent</span>
      )}
      <b className={`mr-fig tnum ${tone}`}>{figure}</b>
      <span className="mr-time">{ago(r.at, now)}</span>
    </article>
  );
}

/** How many of the newest Matches on the first page keep the full banner. */
export const BANNER_ROWS = 4;
