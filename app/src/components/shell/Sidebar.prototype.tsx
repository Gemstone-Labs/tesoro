"use client";

/**
 * PROTOTYPE ONLY: four takes on adding Matches (with open-Match signal) and your Profile to the sidebar.
 * ?variant=now|A|B|C|D. The winner gets rewritten into Sidebar.tsx; this file is deleted.
 */
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, CircleHelp, Gamepad2, HandCoins, House, Swords, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { CATALOGUE } from "@/lib/catalogue";
import type { ChainMatch } from "@/lib/chain/read";
import { GAME_NAMES } from "@/lib/mock";
import { Wordmark, isHere } from "./Sidebar";
import "./sidebar.prototype.css";

export const SIDEBAR_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Count pill + Profile item" },
  { key: "B", name: "Resume card + Profile footer" },
  { key: "C", name: "Nested Matches + identity" },
  { key: "D", name: "Grouped sections" },
] as const;
export type SidebarVariant = (typeof SIDEBAR_VARIANTS)[number]["key"];

type Item = { href: string; label: string; Icon: LucideIcon };
const LOBBY: Item = { href: "/lobby", label: "Lobby", Icon: House };
const PLAY: Item = { href: "/play", label: "Play", Icon: Gamepad2 };
const MATCHES: Item = { href: "/matches", label: "Matches", Icon: Swords };
const BACKING: Item = { href: "/backing", label: "Backing", Icon: HandCoins };
const BOARD: Item = { href: "/leaderboard", label: "Leaderboard", Icon: Trophy };
const WALLET: Item = { href: "/wallet", label: "Wallet", Icon: Wallet };

const nowSecs = () => Math.floor(Date.now() / 1000);
const ready = (m: ChainMatch) => m.status === "active";
function timeLeft(s: number) {
  if (s <= 0) return "Ending";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${Math.floor(s / 3600)} h left`;
}
const tileOf = (m: ChainMatch) => CATALOGUE.find((c) => c.game === m.game)?.tile ?? "";

function useSideData() {
  const { auth, snapshot, openMatches, matches } = useAccount();
  const me = useMemo(
    () => snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null),
    [snapshot, auth.addresses.solana],
  );
  const open = [...openMatches].sort((a, b) => Number(ready(b)) - Number(ready(a)) || a.deadline - b.deadline);
  const won = matches.filter((m) => m.result === "won").length;
  const decided = matches.filter((m) => m.result === "won" || m.result === "lost").length;
  return { me: auth.status === "signed-in" ? me : null, open, anyReady: open.some(ready), won, decided };
}

function NavLink({ item, path, onNavigate, after, className = "" }: { item: Item; path: string; onNavigate?: () => void; after?: React.ReactNode; className?: string }) {
  const here = isHere(path, item.href);
  return (
    <Link href={item.href} className={`cut cut-card side-link ${className}${here ? " here" : ""}`} aria-current={here ? "page" : undefined} onClick={onNavigate}>
      <item.Icon aria-hidden="true" />
      <span className="sp-label">{item.label}</span>
      {after}
    </Link>
  );
}

function ProfileLink({ me, path, onNavigate, label = "Profile" }: { me: string; path: string; onNavigate?: () => void; label?: string }) {
  const href = `/account/${me}`;
  const here = isHere(path, href);
  return (
    <Link href={href} className={`cut cut-card side-link sp-profile${here ? " here" : ""}`} aria-current={here ? "page" : undefined} onClick={onNavigate}>
      <span className="cut sp-av"><PlayerAvatar account={me} size={26} /></span>
      <span className="sp-label">{label}</span>
    </Link>
  );
}

/** Count of open Matches; lit and pulsing when one has an opponent waiting on you. */
function Count({ n, lit }: { n: number; lit: boolean }) {
  if (!n) return null;
  return (
    <span className={`sp-count${lit ? " lit" : ""}`} aria-label={lit ? `${n} open, opponent found` : `${n} open`}>
      {lit && <i aria-hidden="true" />}
      {n}
    </span>
  );
}

function Dot({ lit }: { lit: boolean }) {
  return <span className={`sp-dot${lit ? " lit" : ""}`} aria-label={lit ? "Opponent found" : "Match open"} />;
}

function Lower({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  return (
    <>
      <hr className="side-rule" />
      <div className="side-nav side-lower">
        <NavLink item={{ href: "/docs", label: "Docs", Icon: BookOpen }} path={path} onNavigate={onNavigate} />
        <NavLink item={{ href: "/help", label: "Help", Icon: CircleHelp }} path={path} onNavigate={onNavigate} />
      </div>
    </>
  );
}

export function SidebarPrototype({ variant, onNavigate }: { variant: Exclude<SidebarVariant, "now">; onNavigate?: () => void }) {
  const path = usePathname();
  const d = useSideData();
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), 30_000);
    return () => clearInterval(t);
  }, []);
  const p = { path, onNavigate };

  if (variant === "A") {
    return (
      <>
        <div className="side-top"><Wordmark onNavigate={onNavigate} /></div>
        <nav aria-label="Main" className="side-nav">
          <NavLink item={LOBBY} {...p} />
          <NavLink item={PLAY} {...p} />
          <NavLink item={MATCHES} {...p} after={<Count n={d.open.length} lit={d.anyReady} />} />
          <NavLink item={BACKING} {...p} />
          <NavLink item={BOARD} {...p} />
          <NavLink item={WALLET} {...p} />
          {d.me && <ProfileLink me={d.me} {...p} />}
        </nav>
        <Lower {...p} />
      </>
    );
  }

  if (variant === "B") {
    const m = d.open[0];
    return (
      <>
        <div className="side-top"><Wordmark onNavigate={onNavigate} /></div>
        <nav aria-label="Main" className="side-nav">
          <NavLink item={LOBBY} {...p} />
          <NavLink item={PLAY} {...p} />
          <NavLink item={MATCHES} {...p} after={<Count n={d.open.length} lit={false} />} />
          <NavLink item={BACKING} {...p} />
          <NavLink item={BOARD} {...p} />
          <NavLink item={WALLET} {...p} />
        </nav>
        {m && (
          <Link href={`/play/match/${m.id.toString()}`} className={`cut cut-card sp-resume${ready(m) ? " ready" : ""}`} onClick={onNavigate}>
            <span className="sp-resume-art" aria-hidden="true"><Image src={tileOf(m)} alt="" fill sizes="44px" /></span>
            <span className="sp-resume-body">
              <span className="sp-kicker">{d.open.length > 1 ? `Continue · ${d.open.length}` : "Continue"}</span>
              <b>{GAME_NAMES[m.game]}</b>
              <span className="sp-resume-status"><Dot lit={ready(m)} />{ready(m) ? "Your move" : timeLeft(m.deadline - now)}</span>
            </span>
            <ChevronRight aria-hidden="true" className="sp-chev" />
          </Link>
        )}
        <Lower {...p} />
        {d.me && (
          <Link href={`/account/${d.me}`} className={`cut cut-card sp-foot${isHere(path, `/account/${d.me}`) ? " here" : ""}`} onClick={onNavigate}>
            <span className="cut sp-av lg"><PlayerAvatar account={d.me} size={40} /></span>
            <span className="sp-foot-body">
              <PlayerName account={d.me} className="sp-name" />
              <span className="sp-sub">Your profile</span>
            </span>
            <ChevronRight aria-hidden="true" className="sp-chev" />
          </Link>
        )}
      </>
    );
  }

  if (variant === "C") {
    return (
      <>
        <div className="side-top sp-top-c"><Wordmark onNavigate={onNavigate} /></div>
        {d.me && (
          <Link href={`/account/${d.me}`} className={`cut cut-card sp-id${isHere(path, `/account/${d.me}`) ? " here" : ""}`} onClick={onNavigate}>
            <span className="cut sp-av lg"><PlayerAvatar account={d.me} size={44} /></span>
            <span className="sp-foot-body">
              <PlayerName account={d.me} className="sp-name" />
              <span className="sp-sub">{d.decided ? `${d.won} of ${d.decided} won · Profile` : "Your profile"}</span>
            </span>
          </Link>
        )}
        <nav aria-label="Main" className="side-nav">
          <NavLink item={LOBBY} {...p} />
          <NavLink item={PLAY} {...p} />
          <NavLink item={MATCHES} {...p} after={d.open.length > 0 && <Dot lit={d.anyReady} />} />
          {d.open.length > 0 && (
            <ul className="sp-sub-list" aria-label="Open Matches">
              {d.open.slice(0, 3).map((m) => (
                <li key={m.id.toString()}>
                  <Link href={`/play/match/${m.id.toString()}`} className={`sp-sub-row${ready(m) ? " ready" : ""}`} onClick={onNavigate}>
                    <span className="cut sp-thumb" aria-hidden="true"><Image src={tileOf(m)} alt="" fill sizes="24px" /></span>
                    <span className="sp-sub-text">
                      <b>{GAME_NAMES[m.game]}</b>
                      <span>{ready(m) ? "Your move" : timeLeft(m.deadline - now)}</span>
                    </span>
                    {ready(m) && <Dot lit />}
                  </Link>
                </li>
              ))}
              {d.open.length > 3 && <li className="sp-more"><Link href="/matches" onClick={onNavigate}>+{d.open.length - 3} more</Link></li>}
            </ul>
          )}
          <NavLink item={BACKING} {...p} />
          <NavLink item={BOARD} {...p} />
          <NavLink item={WALLET} {...p} />
        </nav>
        <Lower {...p} />
      </>
    );
  }

  // D: grouped sections with small labels.
  return (
    <>
      <div className="side-top"><Wordmark onNavigate={onNavigate} /></div>
      <nav aria-label="Main" className="sp-groups">
        <div className="sp-group">
          <h3 className="sp-group-h">Play</h3>
          <NavLink item={LOBBY} {...p} />
          <NavLink item={PLAY} {...p} />
          <NavLink item={MATCHES} {...p} after={<Count n={d.open.length} lit={d.anyReady} />} />
        </div>
        <div className="sp-group">
          <h3 className="sp-group-h">Money</h3>
          <NavLink item={BACKING} {...p} />
          <NavLink item={WALLET} {...p} />
        </div>
        <div className="sp-group">
          <h3 className="sp-group-h">Season</h3>
          <NavLink item={BOARD} {...p} />
        </div>
        {d.me && (
          <div className="sp-group">
            <h3 className="sp-group-h">You</h3>
            <ProfileLink me={d.me} {...p} />
          </div>
        )}
      </nav>
      <Lower {...p} />
    </>
  );
}
