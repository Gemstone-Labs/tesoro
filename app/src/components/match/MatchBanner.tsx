import Image from "next/image";
import Link from "next/link";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { Ink } from "@/components/ui/Ink";
import { CheckIcon, MinusIcon, XIcon } from "@/components/ui";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { amountText, backingText, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./match-banner.css";

const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, "no-show": { text: "No-show", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;

/**
 * One finished Match as a banner over the Game's hero art: the result as a poster word, the two
 * Players face to face (with Block Burst scores), the Gema change on a glass chip. Every small line
 * sits on the dark side of the art or on a plate. The banner opens the Match; the opponent's seat
 * leads to their Account (a separate link above it, never nested).
 * `account` is the Account whose history this is: its own seat, or, on a Match it backed, the
 * Player it backed. `backing` replaces the default Backing line under the entry. `me` is the
 * signed-in Account: its seat, when it played, carries a "You" tag.
 */
export function MatchBanner({ r, account, now, backing, me }: { r: HistoryRow; account: string; now: number; backing?: string | null; me?: string | null }) {
  const res = RESULT[r.result];
  const note = backing === undefined ? backingText(r) : backing;
  const player = r.role === "backer" && r.backing ? r.backing.other : account;
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
          {note && <> · {note}</>}
        </small>
      </div>
      <div className="mb-face">
        {player === account ? (
          <Seat account={player} score={r.scores?.[0]} lit={r.result === "won"} dim={r.result === "lost"} you={player === me} />
        ) : (
          <AccountLink account={player} className="mb-seat-link">
            <Seat account={player} score={r.scores?.[0]} lit={r.result === "won"} dim={r.result === "lost"} you={player === me} />
          </AccountLink>
        )}
        <span className="mb-vs" aria-hidden="true">vs</span>
        {r.opp ? (
          <AccountLink account={r.opp} className="mb-seat-link">
            <Seat account={r.opp} score={r.scores?.[1]} lit={r.result === "lost"} dim={r.result === "won"} you={r.opp === me} />
          </AccountLink>
        ) : (
          <span className="mb-seat empty">
            <span className="mb-av-wrap">
              <span className="mb-av" />
            </span>
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

function Seat({ account, score, lit, dim, you }: { account: string; score?: number; lit: boolean; dim: boolean; you: boolean }) {
  return (
    <span className={`mb-seat${lit ? " lit" : ""}${dim ? " dim" : ""}`}>
      <span className="mb-av-wrap">
        <PlayerAvatar account={account} size={52} className="mb-av" />
        {you && <span className="mb-you">You</span>}
      </span>
      <span className="mb-plate">
        <PlayerName account={account} />
        {score !== undefined && <b className="tnum">{fmtGemas(score)}</b>}
      </span>
    </span>
  );
}

/** Loading Match banners: the real banner's blocks and classes with placeholder text, so each is as tall as a loaded one. */
export function MatchBannerSkeleton({ count, label }: { count: number; label: string }) {
  return (
    <div className="mb-list">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, i) => (
        <article key={i} className="cut cut-card mb skel" aria-hidden="true">
          <div className="mb-word">
            <span className="mb-kick">
              <Ink>Block Burst · 2h ago</Ink>
            </span>
            <b>
              <Ink>Won</Ink>
            </b>
            <small>
              <Ink>Entry 500</Ink>
            </small>
          </div>
          <div className="mb-face">
            <SkeletonSeat />
            <span className="mb-vs" aria-hidden="true">vs</span>
            <SkeletonSeat />
          </div>
          <span className="cut cut-chip mb-fig even">
            <Ink>+440 Gemas</Ink>
          </span>
        </article>
      ))}
    </div>
  );
}

function SkeletonSeat() {
  return (
    <span className="mb-seat">
      <span className="mb-av-wrap">
        <span className="mb-av" />
      </span>
      <span className="mb-plate">
        <Ink>Player</Ink>
      </span>
    </span>
  );
}

/** Loading result chips: three chip-shaped blocks in the row the loaded chips take. */
export function ResultFilterSkeleton() {
  return (
    <div className="mh-results" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="cut cut-chip mh-result skel-chip">
          <i />
          <Ink>Refunded 00</Ink>
        </span>
      ))}
    </div>
  );
}
