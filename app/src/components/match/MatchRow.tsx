import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { CheckIcon, GemaMark, MinusIcon, XIcon } from "@/components/ui";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { amountText, backingText, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./history.css";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";

const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;

/** One finished Match: result (icon and word), opponent, score or entry, the Gema change and any Backing. The whole row links to the Match. */
export function MatchRow({ r, now, showGame = false }: { r: HistoryRow; now: number; showGame?: boolean }) {
  const res = RESULT[r.result];
  const note = backingText(r);
  const detail = r.scores ? `${r.scores[0]} – ${r.scores[1]}` : `Entry ${fmtGemas(r.entry)}`;
  return (
    <Link href={`/play/match/${r.id}`} className="cut cut-card mh-row">
      <span className="mh-thumb">
        <Image src={art.thumb[r.game]} alt="" fill sizes="110px" />
      </span>
      <span className={`mh-res ${r.result}`}>
        <res.Icon aria-hidden="true" /> {res.text}
      </span>
      <span className="mh-opp">
        {r.opp && <PlayerAvatar className="mh-av" account={r.opp} size={44} />}
        <span>
          <b>{r.opp ? <PlayerName account={r.opp} /> : "No opponent"}</b>
          <small className="tnum">
            {showGame ? `${GAME_NAMES[r.game]} · ` : ""}
            {detail} · {ago(r.at, now)}
          </small>
        </span>
      </span>
      <span className="mh-amt">
        <b className={r.delta > 0 ? "won" : r.delta < 0 ? "lost" : undefined}>
          {r.delta > 0 && <GemaMark size={20} />}
          {amountText(r)}
        </b>
        {note && <small>{note}</small>}
      </span>
      <ChevronRight aria-hidden="true" className="mh-go" />
    </Link>
  );
}
