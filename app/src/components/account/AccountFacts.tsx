"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { GemaMark } from "@/components/ui";
import { art } from "@/lib/art";
import type { ChainRequest } from "@/lib/chain/backing";
import type { PlayerSummary } from "@/lib/chain/player-account";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_SHORT } from "@/lib/friends/words";
import { GAME_NAMES } from "@/lib/mock";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const rate = (wins: number, of: number) => Math.round((wins / of) * 100);

interface Props {
  s: PlayerSummary;
  now: number;
  visitor: boolean;
  requests: ChainRequest[];
}

/** TEMPORARY: four takes on the facts between the name and the buttons, picked with ?v=a|b|c|d. */
export function AccountFacts(props: Props) {
  const v = useSearchParams().get("v");
  const { s, now, visitor, requests } = props;
  const ask = requests[0];
  const played = s.first !== null;
  if (!played && !ask) return null;
  return (
    <div className={`pa-facts pa-v-${v === "b" || v === "c" || v === "d" ? v : "a"}`}>
      {!played ? null : v === "b" ? <B s={s} /> : v === "c" ? <C s={s} /> : v === "d" ? <D s={s} /> : <A s={s} />}
      {ask && (
        <p className="cut cut-card pa-ask-row">
          <span>
            <b>Asking to be backed</b>
            <span className="pa-ask-meta">
              <GemaMark size={14} />
              {fmtGemas(ask.entry)} · {GAME_SHORT[ask.game]} · {timeLeft(ask.expiresAt, now).replace(" left", "")} left
            </span>
          </span>
          <Link href={`/backing#${ask.address.toBase58()}`}>{visitor ? "Make an Offer" : "See Request"}</Link>
        </p>
      )}
    </div>
  );
}

function record(s: PlayerSummary) {
  return s.record.matches ? `${s.record.wins} of ${s.record.matches} won` : "No winner yet";
}

/** (a) One quiet line, no game art. */
function A({ s }: { s: PlayerSummary }) {
  return (
    <p className="pa-line">
      Playing since {day(s.first!)} <i aria-hidden="true">·</i> {record(s)}
    </p>
  );
}

/** (b) Two big readable stats in one ruled row, the games as a text list with W–L. */
function B({ s }: { s: PlayerSummary }) {
  const { matches, wins } = s.record;
  return (
    <>
      <dl className="pa-big2">
        <div>
          <dt>Record</dt>
          <dd>{matches ? `${wins} of ${matches}` : "None yet"}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd>{matches ? `${rate(wins, matches)}%` : "None yet"}</dd>
        </div>
      </dl>
      <p className="pa-since">Playing since {day(s.first!)}</p>
      {s.byGame.length > 0 && (
        <ul className="pa-gl">
          {s.byGame.map((g) => (
            <li key={g.game}>
              <Image src={art.thumb[g.game]} alt="" width={32} height={32} />
              <span>{GAME_NAMES[g.game]}</span>
              <b>
                {g.wins}–{g.matches - g.wins}
              </b>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** (c) A ruled facts row with small labels; games as small icons with their name in plain text under each. */
function C({ s }: { s: PlayerSummary }) {
  return (
    <>
      <dl className="pa-rule">
        <div>
          <dt>Playing since</dt>
          <dd>{day(s.first!)}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>{record(s)}</dd>
        </div>
      </dl>
      {s.byGame.length > 0 && (
        <ul className="pa-icons">
          {s.byGame.map((g) => (
            <li key={g.game}>
              <Image src={art.thumb[g.game]} alt="" width={44} height={44} />
              <span>{GAME_NAMES[g.game]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** (d) The record as a bar you can read at a glance, and the games as plain words. */
function D({ s }: { s: PlayerSummary }) {
  const { matches, wins } = s.record;
  return (
    <div className="pa-bar">
      <p className="pa-bar-top">
        <b>{matches ? `${wins} of ${matches} won` : "No winner yet"}</b>
        <span>Since {day(s.first!)}</span>
      </p>
      {matches > 0 && (
        <span className="pa-bar-track" aria-hidden="true">
          <i style={{ width: `${rate(wins, matches)}%` }} />
        </span>
      )}
      {s.byGame.length > 0 && (
        <p className="pa-bar-games">
          <span>Plays</span> {s.byGame.map((g) => GAME_NAMES[g.game]).join(", ")}
        </p>
      )}
    </div>
  );
}
