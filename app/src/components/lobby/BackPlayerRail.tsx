"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import type { ChainRequest } from "@/lib/chain/backing";
import { timeLeft, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { Bust, ClockIcon, GemaMark } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { Pnl } from "@/components/backing/Pnl";
import { Rail } from "./Rail";
import "./back-player.css";

const MAX = 12;
/** Win rate pulled toward 50% on small samples, so 3 of 3 does not lead 34 of 52. */
const strength = (r: ChainRequest) => (r.record.wins + 1) / (r.record.matches + 2);

/**
 * BACK A PLAYER: live Requests on a shelf of Player cards, strongest record first, after a card that
 * explains Backing. Each card: the Player's animal over the Game's art, record, P&L, and Back for (the Offer).
 */
export function BackPlayerRail() {
  const { board, loading, error, refresh } = useBackingBoard();
  const { snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const requests = (board?.requests ?? [])
    .filter((r) => r.live)
    .sort((a, b) => strength(b) - strength(a))
    .slice(0, MAX);
  const [shelfRef, shelf] = useShelf(requests.length);

  return (
    <Rail
      id="back-a-player"
      title="Back a player"
      viewAll="/backing"
      cols={3}
      className="bp-rail"
      aside={
        shelf.overflows && (
          <div className="bp-arrows">
            <button type="button" className="cut cut-btn btn neutral sm" aria-label="Previous Players" disabled={shelf.atStart} onClick={() => shelf.page(-1)}>
              <ArrowLeft aria-hidden="true" />
            </button>
            <button type="button" className="cut cut-btn btn neutral sm" aria-label="More Players" disabled={shelf.atEnd} onClick={() => shelf.page(1)}>
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        )
      }
    >
      <div className="bp-shelf" ref={shelfRef}>
        <BackingIntro />
        {loading && !board && <PlayerCardSkeletons />}
        {error && !board && (
          <p className="cut cut-card bp-note">
            Requests couldn’t be loaded. <button type="button" onClick={() => void refresh()}>Try again</button>
          </p>
        )}
        {board && requests.length === 0 && <p className="cut cut-card bp-note">No Players are asking to be backed right now. Check back soon.</p>}
        {requests.map((r) => (
          <PlayerCard key={r.address.toBase58()} r={r} mine={r.player === me} />
        ))}
      </div>
    </Rail>
  );
}

function BackingIntro() {
  return (
    <div className="cut cut-card bp-intro">
      <h3>Fund a Player’s entry. Share what they win.</h3>
      <ol>
        <li>Pick a Player by their record</li>
        <li>Offer to pay their entry</li>
        <li>They win: your entry back, plus your share</li>
      </ol>
      <Link href="/backing" className="cut cut-btn btn neutral sm">
        Post a Request
      </Link>
      <Bust name="herBacking" width={190} className="bp-intro-bust" />
    </div>
  );
}

/** Loading: three Player cards in outline (animal, name, record, P&L, Back for), so the shelf keeps its shape. */
function PlayerCardSkeletons() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading Requests…
      </span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="cut cut-card bp-card skel" aria-hidden="true">
          <div className="bp-face">
            <span className="skel-line bp-game" />
            <span className="cut cut-btn bp-avatar" />
          </div>
          <div className="bp-body">
            <span className="skel-line lg bp-skel-name" />
            <div className="bp-stats">
              {[0, 1, 2].map((j) => (
                <div key={j}>
                  <span className="skel-line bp-skel-fig" />
                  <span className="skel-line bp-skel-label" />
                </div>
              ))}
            </div>
            <div className="bp-skel-pnl">
              <span className="skel-line" />
              <span className="skel-line lg" />
              <span className="bp-skel-spark" />
            </div>
            <span className="cut cut-btn bp-skel-btn" />
          </div>
        </div>
      ))}
    </>
  );
}

function PlayerCard({ r, mine }: { r: ChainRequest; mine: boolean }) {
  const name = usePlayerLabel(r.player);
  const key = r.address.toBase58();
  const { matches, wins } = r.record;
  const left = timeLeft(r.expiresAt);
  return (
    <article className="cut cut-card bp-card" aria-label={`${name}, ${GAME_NAMES[r.game]}`}>
      <div className="bp-face">
        <Image className="bp-art" src={art.hero[r.game]} alt="" fill sizes="280px" />
        <span className="bp-game">{GAME_NAMES[r.game]}</span>
        <span className="bp-time mono" aria-label={left}>
          <ClockIcon width={12} height={12} />
          {left.replace(" left", "")}
        </span>
        <AccountLink account={r.player} decorative className="cut cut-btn avatar bp-avatar">
          <PlayerAvatar account={r.player} size={264} />
        </AccountLink>
      </div>
      <div className="bp-body">
        <strong>
          <AccountLink account={r.player} />
        </strong>
        {matches ? (
          <>
            <dl className="bp-stats">
              <div>
                <dt>Won</dt>
                <dd>{Math.round((wins / matches) * 100)}%</dd>
              </div>
              <div>
                <dt>W</dt>
                <dd>{wins}</dd>
              </div>
              <div>
                <dt>L</dt>
                <dd>{matches - wins}</dd>
              </div>
            </dl>
            <Pnl deltas={r.pnl} />
          </>
        ) : (
          <p className="bp-new">New Player · no settled Matches yet</p>
        )}
        {mine ? (
          <Link href={`/backing#${key}`} className="cut cut-btn btn neutral block">
            Your Request
          </Link>
        ) : (
          <Link
            href={`/backing#${key}`}
            className="cut cut-btn btn money block"
            aria-label={`Offer to back ${name} in ${GAME_NAMES[r.game]} for ${fmtGemas(r.entry)} Gemas`}
          >
            Back for <GemaMark size={16} /> {fmtGemas(r.entry)}
          </Link>
        )}
      </div>
    </article>
  );
}

/** A horizontally scrolling shelf: whether it overflows, whether it sits at either end, and paging by most of its width. */
function useShelf(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflows: false, atStart: true, atEnd: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () =>
      setEdges({
        overflows: el.scrollWidth > el.clientWidth + 4,
        atStart: el.scrollLeft <= 4,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
      });
    // Observing fires once straight away, and again whenever the shelf is resized; `count` re-runs it when cards arrive.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    el.addEventListener("scroll", read, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", read);
    };
  }, [count]);
  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: still ? "auto" : "smooth" });
  };
  return [ref, { page, ...edges }] as const;
}
