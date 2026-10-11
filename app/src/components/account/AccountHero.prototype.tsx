"use client";

/**
 * PROTOTYPE ONLY (branch proto/account-hero-11-10-2026). Four Account hero designs on the real
 * `/account/<key>` page, switched by `?variant=` (now = the shipped hero, rendered by AccountView).
 *   A Player card   record-first: identity on top, the record as a strip of display figures
 *   B Banner        the favourite game's key art as a cover, avatar over its edge, labelled facts
 *   C Strip         one compact identity bar, the scoreboard below gets the stage
 *   D Challenge     identity left, the Challenge itself (game tiles + button) as the right panel
 */
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { CalendarDays, Check, Clock, Copy, Link2, Pencil, Swords } from "lucide-react";
import { PlayerAvatar, PlayerName, VerifiedMark } from "@/components/account/Player";
import { Button, GemaMark, Label } from "@/components/ui";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { signed, type PlayerSummary } from "@/lib/chain/player-account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES, type GameId } from "@/lib/mock";
import "./account-hero.prototype.css";

export const HERO_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Player card" },
  { key: "B", name: "Banner" },
  { key: "C", name: "Strip" },
  { key: "D", name: "Challenge" },
] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number]["key"];

export interface HeroProps {
  address: string;
  own: boolean;
  visitor: boolean;
  s: PlayerSummary;
  now: number;
  otherNames: { suffix: ".sol" | ".eth"; name: string }[];
  /** Live Requests this Player has open (the strip below the hero lists them). */
  asking: number;
  copied: boolean;
  onCopy: () => void;
  onChallenge: (game?: GameId) => void;
  onEdit: () => void;
}

const HERO_ART: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero };
const ALL_GAMES: GameId[] = ["block-puzzle", "holdem", "trading-duel"];
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const favourite = (s: PlayerSummary): GameId => [...s.byGame].sort((a, b) => b.matches - a.matches)[0]?.game ?? "block-puzzle";
const wl = (wins: number, of: number) => `${wins}–${of - wins}`;

export function AccountHeroPrototype({ variant, ...p }: HeroProps & { variant: Exclude<HeroVariant, "now"> }) {
  if (variant === "A") return <PlayerCard {...p} />;
  if (variant === "B") return <Banner {...p} />;
  if (variant === "C") return <Strip {...p} />;
  return <ChallengeLed {...p} />;
}

/** The key as a chip that copies itself: the long mono line goes, the key stays one click away. */
function KeyChip({ address }: { address: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="cut cut-chip ph-key"
      title={address}
      onClick={() =>
        void navigator.clipboard?.writeText(address).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        })
      }
    >
      <span className="mono">
        {address.slice(0, 6)}…{address.slice(-6)}
      </span>
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className="sr-only">{done ? "Account key copied" : `Copy Account key ${address}`}</span>
    </button>
  );
}

function Names({ names }: { names: HeroProps["otherNames"] }) {
  if (names.length === 0) return null;
  return (
    <span className="pa-names">
      {names.map((n) => (
        <span key={n.suffix} className="pn">
          <span className="pn-label">{n.name}</span>
          <VerifiedMark suffix={n.suffix} />
        </span>
      ))}
    </span>
  );
}

/** Challenge (or Edit profile on your own page) plus Copy link as an icon button. */
function Actions({ own, visitor, copied, onCopy, onChallenge, onEdit, className }: Pick<HeroProps, "own" | "visitor" | "copied" | "onCopy" | "onChallenge" | "onEdit"> & { className?: string }) {
  return (
    <div className={`ph-actions${className ? ` ${className}` : ""}`}>
      {visitor && (
        <Button onClick={() => onChallenge()} icon={<Swords aria-hidden="true" />}>
          Challenge
        </Button>
      )}
      {own && (
        <Button onClick={onEdit} icon={<Pencil aria-hidden="true" />}>
          Edit profile
        </Button>
      )}
      <button type="button" className="cut cut-btn btn ph-icon" onClick={onCopy} title={copied ? "Link copied" : "Copy link to this Account"}>
        {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
        <span className="sr-only">{copied ? "Link copied" : "Copy link to this Account"}</span>
      </button>
    </div>
  );
}

function Activity({ s, now }: { s: PlayerSummary; now: number }) {
  if (s.latest === null) return <span className="ph-activity quiet">No Matches yet</span>;
  const fresh = now - s.latest < 60 * 60 * 1000;
  return (
    <span className={`ph-activity${fresh ? " fresh" : ""}`}>
      <i aria-hidden="true" />
      Played {ago(s.latest, now)}
    </span>
  );
}

/* ——— A: Player card ——— */
function PlayerCard(p: HeroProps) {
  const { s } = p;
  const rate = s.record.matches ? Math.round((s.record.wins / s.record.matches) * 100) : null;
  return (
    <header className="cut cut-frame pha">
      <span className="cut cut-btn avatar pha-avatar">
        <PlayerAvatar account={p.address} size={132} />
      </span>
      <div className="pha-id">
        <div className="pha-kicker">
          <Label>{p.own ? "Your Account" : "Player"}</Label>
          <Activity s={s} now={p.now} />
        </div>
        <h1 className="page-title">
          <PlayerName account={p.address} />
        </h1>
        <div className="pha-sub">
          <Names names={p.otherNames} />
          <KeyChip address={p.address} />
        </div>
      </div>
      <Actions {...p} className="pha-actions" />
      <dl className="pha-stats">
        <div>
          <dt>Record</dt>
          <dd>{s.record.matches ? wl(s.record.wins, s.record.matches) : "—"}</dd>
          <small>{s.record.matches ? `${rate}% of ${s.record.matches} won` : "No winner yet"}</small>
        </div>
        <div>
          <dt>Gemas won and lost</dt>
          <dd className="pha-gemas">
            <GemaMark size={22} />
            {signed(s.net)}
          </dd>
          <small>After Fees</small>
        </div>
        {s.bestScore !== null && (
          <div>
            <dt>Best score</dt>
            <dd>{fmtGemas(s.bestScore)}</dd>
            <small>{GAME_NAMES["block-puzzle"]}</small>
          </div>
        )}
        <div>
          <dt>Playing since</dt>
          <dd>{s.first !== null ? day(s.first) : "—"}</dd>
          <small>{s.byGame.length ? s.byGame.map((g) => GAME_NAMES[g.game]).join(" · ") : "No games yet"}</small>
        </div>
      </dl>
      {p.visitor && p.asking === 0 && (
        <p className="pha-foot">
          Not asking to be backed. <Link href="/backing">Players who are</Link>
        </p>
      )}
    </header>
  );
}

/* ——— B: Banner ——— */
function Banner(p: HeroProps) {
  const { s } = p;
  const fav = favourite(s);
  return (
    <header className="cut cut-frame phb">
      <div className="phb-art">
        <Image src={HERO_ART[fav]} alt="" fill sizes="1080px" priority />
        <Activity s={s} now={p.now} />
      </div>
      <div className="phb-who">
        <span className="cut cut-btn avatar phb-avatar">
          <PlayerAvatar account={p.address} size={140} />
        </span>
        <div className="phb-name">
          <h1 className="page-title">
            <PlayerName account={p.address} />
          </h1>
          <div className="pha-sub">
            <Names names={p.otherNames} />
            <KeyChip address={p.address} />
            {p.own && <span className="ph-tag">How other Players see you</span>}
          </div>
        </div>
        <Actions {...p} className="phb-actions" />
      </div>
      <dl className="phb-facts">
        <div>
          <dt>
            <CalendarDays aria-hidden="true" /> Playing since
          </dt>
          <dd>{s.first !== null ? day(s.first) : "Not yet"}</dd>
        </div>
        <div>
          <dt>
            <Swords aria-hidden="true" /> Record
          </dt>
          <dd>{s.record.matches ? `${s.record.wins} of ${s.record.matches} won` : "No winner yet"}</dd>
        </div>
        <div className="phb-games">
          <dt>Plays</dt>
          <dd>
            {s.byGame.length === 0
              ? "No games yet"
              : s.byGame.map((g) => (
                  <span key={g.game} className="phb-game">
                    <span className="cut cut-chip phb-thumb">
                      <Image src={art.thumb[g.game]} alt="" width={28} height={28} />
                    </span>
                    {GAME_NAMES[g.game]}
                  </span>
                ))}
          </dd>
        </div>
        {p.visitor && (
          <div>
            <dt>Backing</dt>
            <dd>{p.asking > 0 ? <a href="#pa-asks">Asking now ↓</a> : <Link href="/backing">Not asking · see who is</Link>}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}

/* ——— C: Strip ——— */
function Strip(p: HeroProps) {
  const { s } = p;
  return (
    <header className="cut cut-card phc">
      <span className="cut cut-btn avatar phc-avatar">
        <PlayerAvatar account={p.address} size={72} />
      </span>
      <div className="phc-id">
        <div className="phc-line">
          <h1 className="phc-name">
            <PlayerName account={p.address} />
          </h1>
          <KeyChip address={p.address} />
        </div>
        <div className="phc-meta">
          <Activity s={s} now={p.now} />
          {s.first !== null && <span>Since {day(s.first)}</span>}
          <Names names={p.otherNames} />
          {p.own && <span>How other Players see you</span>}
          {p.visitor && p.asking === 0 && <span>Not asking to be backed</span>}
        </div>
      </div>
      {s.byGame.length > 0 && (
        <ul className="phc-games" aria-label="Games played">
          {s.byGame.map((g) => (
            <li key={g.game} className="cut cut-chip" title={`${GAME_NAMES[g.game]}: ${g.wins} of ${g.matches} won`}>
              <Image src={art.thumb[g.game]} alt="" width={40} height={40} />
              <span className="sr-only">
                {GAME_NAMES[g.game]}: {g.wins} of {g.matches} won
              </span>
              <b aria-hidden="true">{wl(g.wins, g.matches)}</b>
            </li>
          ))}
        </ul>
      )}
      <Actions {...p} className="phc-actions" />
    </header>
  );
}

/* ——— D: Challenge-led ——— */
function ChallengeLed(p: HeroProps) {
  const { s } = p;
  const played = new Set(s.byGame.map((g) => g.game));
  const [game, setGame] = useState<GameId>(favourite(s));
  return (
    <header className="cut cut-frame phd">
      <div className="phd-id">
        <span className="cut cut-btn avatar phd-avatar">
          <PlayerAvatar account={p.address} size={112} />
        </span>
        <div className="phd-name">
          <Label>{p.own ? "Your Account" : "Player"}</Label>
          <h1 className="page-title">
            <PlayerName account={p.address} />
          </h1>
          <div className="pha-sub">
            <Names names={p.otherNames} />
            <KeyChip address={p.address} />
          </div>
        </div>
        <ul className="phd-facts">
          {s.first !== null && (
            <li>
              <CalendarDays aria-hidden="true" /> Playing since {day(s.first)}
            </li>
          )}
          {s.latest !== null && (
            <li>
              <Clock aria-hidden="true" /> Last Match {ago(s.latest, p.now)}
            </li>
          )}
          {s.record.matches > 0 && (
            <li>
              <Swords aria-hidden="true" /> {s.record.wins} of {s.record.matches} won
            </li>
          )}
          {p.visitor && p.asking === 0 && (
            <li className="quiet">
              Not asking to be backed · <Link href="/backing">see who is</Link>
            </li>
          )}
        </ul>
      </div>

      {p.own ? (
        <div className="cut cut-card phd-panel">
          <b className="phd-title">Share your Account</b>
          <p>Anyone with the link sees your Matches and your record, never your Wallet.</p>
          <div className="cut cut-chip phd-url">
            <span className="mono">/account/{p.address.slice(0, 10)}…</span>
          </div>
          <div className="phd-row">
            <Button onClick={p.onCopy} icon={p.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}>
              {p.copied ? "Link copied" : "Copy link"}
            </Button>
            <Button onClick={p.onEdit} icon={<Pencil aria-hidden="true" />}>
              Edit profile
            </Button>
          </div>
        </div>
      ) : (
        <div className="cut cut-card phd-panel">
          <b className="phd-title">Challenge this Player</b>
          <fieldset className="phd-games">
            <legend className="sr-only">Game</legend>
            {ALL_GAMES.map((g) => (
              <label key={g} className="phd-game">
                <input type="radio" name="phd-game" value={g} checked={game === g} onChange={() => setGame(g)} />
                <span className="cut cut-card">
                  <Image src={art.thumb[g]} alt="" width={96} height={96} />
                  <b>{GAME_NAMES[g]}</b>
                  {played.has(g) && <small>Plays this</small>}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="phd-row">
            <Button onClick={() => p.onChallenge(game)} icon={<Swords aria-hidden="true" />}>
              Challenge at {GAME_NAMES[game]}
            </Button>
            <button type="button" className="cut cut-btn btn ph-icon" onClick={p.onCopy} title={p.copied ? "Link copied" : "Copy link to this Account"}>
              {p.copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              <span className="sr-only">{p.copied ? "Link copied" : "Copy link to this Account"}</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
