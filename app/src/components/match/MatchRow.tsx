import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { CheckIcon, GemaMark, MinusIcon, XIcon } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { art, avatarFor } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { amountText, backingText, shortKey, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./history.css";

const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;

/**
 * One finished Match: result (icon and word), opponent, score or entry, the Gema change and any Backing.
 * The row links to the Match, which only its Players and Backer can open. On someone else's Account
 * (`link="opponent"`) the row is not a link and the opponent leads to their Account instead.
 * `backing` replaces the default Backing line.
 */
export function MatchRow({
  r,
  now,
  showGame = false,
  link = "match",
  backing,
}: {
  r: HistoryRow;
  now: number;
  showGame?: boolean;
  link?: "match" | "opponent";
  backing?: string | null;
}) {
  const res = RESULT[r.result];
  const note = backing === undefined ? backingText(r) : backing;
  const detail = r.scores ? `${r.scores[0]} – ${r.scores[1]}` : `Entry ${fmtGemas(r.entry)}`;
  const opp = (
    <>
      {r.opp && <Image className="mh-av" src={avatarFor(r.opp)} alt="" width={44} height={44} />}
      <span>
        <b>{r.opp ? shortKey(r.opp) : "No opponent"}</b>
        <small className="tnum">
          {showGame ? `${GAME_NAMES[r.game]} · ` : ""}
          {detail} · {ago(r.at, now)}
        </small>
      </span>
    </>
  );
  const cells = (
    <>
      <span className="mh-thumb">
        <Image src={art.thumb[r.game]} alt="" fill sizes="110px" />
      </span>
      <span className={`mh-res ${r.result}`}>
        <res.Icon aria-hidden="true" /> {res.text}
      </span>
      {link === "opponent" && r.opp ? (
        <AccountLink account={r.opp} className="mh-opp">
          {opp}
        </AccountLink>
      ) : (
        <span className="mh-opp">{opp}</span>
      )}
      <span className="mh-amt">
        <b className={r.delta > 0 ? "won" : undefined}>
          {r.delta > 0 && <GemaMark size={20} />}
          {amountText(r)}
        </b>
        {note && <small>{note}</small>}
      </span>
    </>
  );
  if (link === "opponent") return <div className="cut cut-card mh-row still">{cells}</div>;
  return (
    <Link href={`/play/match/${r.id}`} className="cut cut-card mh-row">
      {cells}
      <ChevronRight aria-hidden="true" className="mh-go" />
    </Link>
  );
}
