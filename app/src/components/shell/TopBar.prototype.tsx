"use client";

/**
 * PROTOTYPE ONLY (branch proto/topbar-points-11-10-2026). Five takes on the top bar with the Player's
 * Leaderboard points in it, switchable with `?variant=now|A|B|C|D|E`. The winner gets rewritten into
 * TopBar.tsx on main; this file never merges.
 *
 * A Season plate: Pool and your place joined in one gold-framed plate (the Season is one thing).
 * B Player plate: the avatar grows into a chip with your name and "#3 · 371 pts", rank badge on the avatar.
 * C Points pill: a third steel pill with a meter to the next rank; hover opens a Season card.
 * D Console: one continuous plate, Pool | rank + points | Gemas, colour only on the figures.
 * E Season strip: the empty middle of the bar becomes a Season ticker (ends in, Pool, you, gap to next).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Menu, Search, X } from "lucide-react";
import { TesoroMark } from "@/components/brand";
import { PlayerName } from "@/components/account/Player";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { usePool } from "@/lib/chain/usePool";
import { fmtGemas } from "@/lib/format";
import { AccountMenu } from "./AccountMenu";
import { Chest, PoolChest } from "./PoolChest";
import { useSearch } from "./SearchContext";
import { Wordmark } from "./Sidebar";
import "./topbar.prototype.css";

export const TOPBAR_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Season plate" },
  { key: "B", name: "Player plate" },
  { key: "C", name: "Points pill + meter" },
  { key: "D", name: "Console" },
  { key: "E", name: "Season strip" },
] as const;
export type TopBarVariant = (typeof TOPBAR_VARIANTS)[number]["key"];

const SHORT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const compact = (n: number) => (n < 10_000 ? fmtGemas(n) : SHORT.format(n));
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

interface Standing {
  season: number;
  /** Seconds left in the season. */
  left: number;
  pool: number;
  players: number;
  /** null: no points this season (or outside the top 50 the API returns). */
  rank: number | null;
  points: number;
  wins: number;
  /** Gemas this rank would take from the Pool now; 0 outside the prizes. */
  prize: number;
  /** Points to pass the Player above; null at 1st. */
  toNext: number | null;
  /** Points to reach 10th; 0 when already in the prizes. */
  toPrizes: number;
  /** Progress 0..1 from the rank below towards the rank above (or to 10th from 0 when outside). */
  meter: number;
}

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function useStanding(): Standing | null {
  const { data } = useLeaderboard();
  const { auth, snapshot } = useAccount();
  const live = usePool();
  const now = useNow();
  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
  return useMemo(() => {
    if (!data || data.feeBps === 0) return null;
    const pool = live ?? data.poolGemas;
    const rows = data.standings;
    const i = me ? rows.findIndex((r) => r.account === me) : -1;
    const row = i >= 0 ? rows[i] : null;
    const tenth = rows[PRIZE_PLACES - 1]?.points ?? 0;
    const above = i > 0 ? rows[i - 1] : null;
    const below = i >= 0 ? rows[i + 1] : null;
    const points = row?.points ?? 0;
    const toNext = above ? above.points - points + 1 : null;
    const toPrizes = row && row.rank <= PRIZE_PLACES ? 0 : Math.max(1, tenth - points + 1);
    let meter = 0;
    if (row && above) meter = (points - (below?.points ?? 0)) / Math.max(1, above.points - (below?.points ?? 0));
    else if (row && !above) meter = 1;
    else meter = tenth ? points / tenth : 0;
    return {
      season: data.season.number,
      left: Math.max(0, data.season.end - now),
      pool,
      players: data.players,
      rank: row?.rank ?? null,
      points,
      wins: row?.wins ?? 0,
      prize: row && row.rank <= PRIZE_PLACES ? Math.floor((pool * PRIZE_BPS[row.rank - 1]) / 10_000) : 0,
      toNext,
      toPrizes,
      meter: Math.min(1, Math.max(0.04, meter)),
    };
  }, [data, live, me, now]);
}

const leftIn = (s: number) => {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** The next thing to aim for, in one short line. */
function goal(s: Standing) {
  if (s.rank === null) return "Win a Match to get on the board";
  if (s.rank > PRIZE_PLACES) return `${s.toPrizes} pts to the prizes`;
  if (s.toNext === null) return "Top of the board";
  return `${s.toNext} pts to ${ordinal(s.rank - 1)}`;
}

/** A small steel octagon with the rank in it. */
function RankPlate({ rank, size = "md" }: { rank: number | null; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`tbp-rank tbp-rank-${size}${rank !== null && rank <= 3 ? " podium" : ""}${rank !== null && rank >= 10 ? " wide" : ""}`} aria-hidden="true">
      {rank === null ? "—" : <><i>#</i>{rank}</>}
    </span>
  );
}

/* ——— shared pieces, unchanged from the real bar ——— */

function Brand({ onMenu }: { onMenu: () => void }) {
  return (
    <>
      <button type="button" className="cut icon-btn menu-btn" aria-label="Open menu" onClick={onMenu}>
        <Menu aria-hidden="true" />
      </button>
      <span className="top-word"><Wordmark /></span>
      <Link href="/lobby" className="top-mark" aria-label="Tesoro, home">
        <TesoroMark size={32} />
      </Link>
    </>
  );
}

function SearchBox() {
  const { query, setQuery } = useSearch();
  const path = usePathname();
  const router = useRouter();
  const onLobby = path === "/lobby";
  return (
    <form className="cut cut-card search" role="search" onSubmit={(e) => { e.preventDefault(); if (!onLobby) router.push("/lobby"); }}>
      <Search aria-hidden="true" />
      <input
        type="search" name="q" aria-label="Search games" placeholder="Search games" autoComplete="off" value={query}
        onChange={(e) => { setQuery(e.target.value); if (!onLobby && e.target.value) router.push("/lobby"); }}
      />
      {query && (
        <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
          <X aria-hidden="true" />
        </button>
      )}
    </form>
  );
}

function GemasPill() {
  const { gemas, ready } = useAccount();
  return (
    <Link href="/wallet" className="cut cut-card gpill" aria-label="Your Gemas, open Wallet">
      <GemaMark size={30} glint />
      <b className="tnum">{ready ? <CountUp value={gemas.total} /> : "—"}</b>
      <span>Gemas</span>
    </Link>
  );
}

function useBar() {
  const { auth } = useAccount();
  const path = usePathname();
  return {
    signedIn: auth.status === "signed-in",
    signedOut: auth.status === "signed-out",
    showBalance: auth.status !== "signed-out" && auth.status !== "loading",
    openSignIn: () => auth.openSignIn(),
    onLobby: path === "/lobby",
  };
}

/* ——— A: Season plate ——— */

function VariantA({ onMenu }: { onMenu: () => void }) {
  const bar = useBar();
  const s = useStanding();
  const pool = usePool();
  return (
    <header className={`topbar tbp tbp-a${bar.onLobby ? " on-lobby" : ""}`}>
      <Brand onMenu={onMenu} />
      <SearchBox />
      <div className="top-right">
        {pool != null && (
          <Link href="/leaderboard" className="cut cut-card tbpa-plate" aria-label="Leaderboard: the Pool and your place">
            <span className="tbpa-pool">
              <Chest size={40} />
              <span className="tbpa-stack">
                <b className="tbp-gold"><CountUp value={pool} duration={1200} format={compact} /></b>
                <small>Pool · Season {s?.season ?? "—"}</small>
              </span>
            </span>
            {bar.signedIn && s && (
              <span className="tbpa-you">
                <RankPlate rank={s.rank} />
                <span className="tbpa-stack">
                  <b>{s.rank === null ? "No points" : <><CountUp value={s.points} /> <em>pts</em></>}</b>
                  <small>{goal(s)}</small>
                </span>
              </span>
            )}
          </Link>
        )}
        {bar.showBalance && <GemasPill />}
        {bar.signedIn && <AccountMenu />}
        {bar.signedOut && <Button onClick={bar.openSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ——— B: Player plate ——— */

function PlayerPlate() {
  const s = useStanding();
  const { auth, snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
  return (
    <div className="tbpb-player">
      <Link href="/leaderboard" className="tbpb-stand" aria-label="Your Leaderboard place">
        <span className="tbpb-name">{me ? <PlayerName account={me} /> : "You"}</span>
        <span className="tbpb-line">
          {s?.rank != null ? (
            <><b>{ordinal(s.rank)}</b><span className="tbp-dot" /><b><CountUp value={s.points} /></b> pts</>
          ) : (
            <>No Season points yet</>
          )}
        </span>
      </Link>
      <span className="tbpb-avatar">
        <AccountMenu />
        {s?.rank != null && <RankPlate rank={s.rank} size="sm" />}
      </span>
    </div>
  );
}

function VariantB({ onMenu }: { onMenu: () => void }) {
  const bar = useBar();
  return (
    <header className={`topbar tbp tbp-b${bar.onLobby ? " on-lobby" : ""}`}>
      <Brand onMenu={onMenu} />
      <SearchBox />
      <div className="top-right">
        <PoolChest />
        {bar.showBalance && <GemasPill />}
        {bar.signedIn && <PlayerPlate />}
        {bar.signedOut && <Button onClick={bar.openSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ——— C: Points pill with a meter and a Season card on hover ——— */

function PointsPill() {
  const s = useStanding();
  if (!s) return null;
  return (
    <div className="tbpc-wrap">
      <Link href="/leaderboard" className="cut cut-card tbpc-pill" aria-label={`Season points: ${s.points}. ${goal(s)}`}>
        <RankPlate rank={s.rank} />
        <span className="tbpc-fig">
          <b><CountUp value={s.points} /></b>
          <span>pts</span>
        </span>
        <span className="tbpc-meter" aria-hidden="true"><i style={{ width: `${s.meter * 100}%` }} /></span>
      </Link>
      <div className="cut cut-card tbpc-card" role="tooltip">
        <span className="tbpc-k">Season {s.season} · ends in <b className="mono">{leftIn(s.left)}</b></span>
        <div className="tbpc-big">
          <RankPlate rank={s.rank} size="lg" />
          <span>
            <b>{s.rank === null ? "Not ranked yet" : `${ordinal(s.rank)} of ${s.players}`}</b>
            <small>{s.points} points · {s.wins} wins</small>
          </span>
        </div>
        <div className="tbpc-goal">
          <span>{goal(s)}</span>
          <span className="tbpc-meter lg"><i style={{ width: `${s.meter * 100}%` }} /></span>
        </div>
        <dl className="tbpc-kv">
          <div><dt>If the Season ended now</dt><dd className={s.prize ? "tbp-em" : ""}>{s.prize ? <>◆ {fmtGemas(s.prize)}</> : "Outside the top 10"}</dd></div>
          <div><dt>Leaderboard Pool</dt><dd className="tbp-gold">{fmtGemas(s.pool)}</dd></div>
          <div><dt>Points per win</dt><dd>5 · 10 · 25 by entry</dd></div>
        </dl>
        <span className="tbpc-more">See the Leaderboard <ChevronRight aria-hidden="true" /></span>
      </div>
    </div>
  );
}

function VariantC({ onMenu }: { onMenu: () => void }) {
  const bar = useBar();
  return (
    <header className={`topbar tbp tbp-c${bar.onLobby ? " on-lobby" : ""}`}>
      <Brand onMenu={onMenu} />
      <SearchBox />
      <div className="top-right">
        <PoolChest />
        {bar.signedIn && <PointsPill />}
        {bar.showBalance && <GemasPill />}
        {bar.signedIn && <AccountMenu />}
        {bar.signedOut && <Button onClick={bar.openSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ——— D: Console ——— */

function VariantD({ onMenu }: { onMenu: () => void }) {
  const bar = useBar();
  const s = useStanding();
  const pool = usePool();
  const { gemas, ready } = useAccount();
  return (
    <header className={`topbar tbp tbp-d${bar.onLobby ? " on-lobby" : ""}`}>
      <Brand onMenu={onMenu} />
      <SearchBox />
      <div className="top-right">
        <div className="cut cut-card tbpd-console">
          {pool != null && (
            <Link href="/leaderboard" className="tbpd-cell tbpd-pool" aria-label="Leaderboard Pool">
              <Chest size={34} />
              <span className="tbpd-stack"><b className="tbp-gold"><CountUp value={pool} duration={1200} format={compact} /></b><small>Pool</small></span>
            </Link>
          )}
          {bar.signedIn && s && (
            <Link href="/leaderboard" className="tbpd-cell tbpd-pts" aria-label="Your Season points">
              <RankPlate rank={s.rank} size="sm" />
              <span className="tbpd-stack"><b><CountUp value={s.points} /></b><small>Points</small></span>
            </Link>
          )}
          {bar.showBalance && (
            <Link href="/wallet" className="tbpd-cell tbpd-gemas" aria-label="Your Gemas, open Wallet">
              <GemaMark size={28} glint />
              <span className="tbpd-stack"><b>{ready ? <CountUp value={gemas.total} /> : "—"}</b><small>Gemas</small></span>
            </Link>
          )}
        </div>
        {bar.signedIn && <AccountMenu />}
        {bar.signedOut && <Button onClick={bar.openSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ——— E: Season strip ——— */

function SeasonStrip({ signedIn }: { signedIn: boolean }) {
  const s = useStanding();
  if (!s) return null;
  return (
    <Link href="/leaderboard" className="cut cut-card tbpe-strip" aria-label="This Season on the Leaderboard">
      <span className="tbpe-seg tbpe-season">
        <b>Season {s.season}</b>
        <span className="mono">{leftIn(s.left)} left</span>
      </span>
      <span className="tbpe-seg tbpe-pool">
        <Chest size={30} />
        <b className="tbp-gold"><CountUp value={s.pool} duration={1200} format={compact} /></b>
        <span>Pool</span>
      </span>
      {signedIn ? (
        <span className="tbpe-seg tbpe-you">
          <RankPlate rank={s.rank} size="sm" />
          <b>{s.rank === null ? "No points" : <><CountUp value={s.points} /> pts</>}</b>
          <span className="tbpe-goal">{goal(s)}</span>
          {s.prize > 0 && <span className="tbpe-prize tbp-em">◆ {fmtGemas(s.prize)} if it ended now</span>}
        </span>
      ) : (
        <span className="tbpe-seg tbpe-you"><span className="tbpe-goal">Top 10 share the Pool</span></span>
      )}
      <ChevronRight aria-hidden="true" className="tbpe-go" />
    </Link>
  );
}

function VariantE({ onMenu }: { onMenu: () => void }) {
  const bar = useBar();
  return (
    <header className={`topbar tbp tbp-e${bar.onLobby ? " on-lobby" : ""}`}>
      <Brand onMenu={onMenu} />
      <SearchBox />
      <SeasonStrip signedIn={bar.signedIn} />
      <div className="top-right">
        {bar.showBalance && <GemasPill />}
        {bar.signedIn && <AccountMenu />}
        {bar.signedOut && <Button onClick={bar.openSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

export function TopBarPrototype({ variant, onMenu }: { variant: Exclude<TopBarVariant, "now">; onMenu: () => void }) {
  if (variant === "A") return <VariantA onMenu={onMenu} />;
  if (variant === "B") return <VariantB onMenu={onMenu} />;
  if (variant === "C") return <VariantC onMenu={onMenu} />;
  if (variant === "D") return <VariantD onMenu={onMenu} />;
  return <VariantE onMenu={onMenu} />;
}

