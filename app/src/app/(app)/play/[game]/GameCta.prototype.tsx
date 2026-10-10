"use client";

/**
 * PROTOTYPE ONLY: four takes on the Game page's actions (Play now / Challenge a friend / Practice),
 * switched by `?variant=` on /play/<game>. Question: how should the one money action and the two
 * free ways to play read, so the hierarchy and the difference between them are obvious?
 * Throwaway: fold the winner into GamePage properly and delete this file.
 */
import { Suspense } from "react";
import { ArrowRight, Dumbbell, Link2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { Button, GemaMark } from "@/components/ui";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { useQueue } from "@/components/lobby/useQueue";
import { fmtGemas } from "@/lib/format";
import type { GameId } from "@/lib/mock";
import "./game-cta.prototype.css";

const VARIANTS = [
  { key: "A", name: "One action + quiet links" },
  { key: "B", name: "Three mode cards" },
  { key: "C", name: "Big button + paired row" },
  { key: "now", name: "Current" },
] as const;

type Props = {
  game: GameId;
  entry: number;
  asset: number;
  practiceLine: string;
  onPlay: () => void;
  onChallenge: () => void;
  practiceHref: string;
};

export function GameCta(p: Props) {
  return (
    <Suspense>
      <Inner {...p} />
      <PrototypeSwitcher variants={[...VARIANTS]} />
    </Suspense>
  );
}

function Inner(p: Props) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  const queue = useQueue();
  const waiting = queue ? queue[p.game].filter((s) => s.entry === p.entry && (p.game !== "trading-duel" || s.asset === p.asset)).length : null;
  if (v === "A") return <CtaLinks {...p} />;
  if (v === "B") return <CtaModes {...p} waiting={waiting} />;
  if (v === "C") return <CtaPaired {...p} waiting={waiting} />;
  return (
    <div className="gp-cta">
      <Button variant="money" size="lg" onClick={p.onPlay}>
        Play now
      </Button>
      <Button size="lg" onClick={p.onChallenge}>
        Challenge<span className="gp-friend"> a friend</span> <Link2 aria-hidden="true" />
      </Button>
      <Button size="lg" href={p.practiceHref}>
        Practice
      </Button>
    </div>
  );
}

/** A: one emerald action carrying the entry; the free ways to play drop to quiet links under it. */
function CtaLinks(p: Props) {
  return (
    <div className="ctaA">
      <button type="button" className="cut cut-btn btn money lg ctaA-play" onClick={p.onPlay}>
        Play now
        <span className="ctaA-entry">
          <GemaMark size={18} />
          {fmtGemas(p.entry)}
        </span>
      </button>
      <div className="ctaA-links">
        <button type="button" onClick={p.onChallenge}>
          <UserPlus aria-hidden="true" />
          Challenge a friend
        </button>
        <span aria-hidden="true">·</span>
        <Link href={p.practiceHref}>
          <Dumbbell aria-hidden="true" />
          Practice free
        </Link>
      </div>
    </div>
  );
}

/** B: three ways to play as three cards that say what each one is; only the money one is emerald. */
function CtaModes(p: Props & { waiting: number | null }) {
  return (
    <div className="ctaB" role="group" aria-label="Ways to play">
      <button type="button" className="cut cut-btn btn money ctaB-card" onClick={p.onPlay}>
        <span className="ctaB-top">
          <b>Play now</b>
          <ArrowRight aria-hidden="true" />
        </span>
        <span className="ctaB-line">
          <GemaMark size={15} /> {fmtGemas(p.entry)} entry · {p.waiting ? `${p.waiting} waiting` : "matched in the Queue"}
        </span>
      </button>
      <button type="button" className="cut cut-btn btn neutral ctaB-card" onClick={p.onChallenge}>
        <span className="ctaB-top">
          <b>Challenge a friend</b>
        </span>
        <span className="ctaB-line">
          <UserPlus aria-hidden="true" />
          Share a link, they join
        </span>
      </button>
      <Link href={p.practiceHref} className="cut cut-btn btn neutral ctaB-card">
        <span className="ctaB-top">
          <b>Practice</b>
        </span>
        <span className="ctaB-line">
          <Dumbbell aria-hidden="true" />
          Free · {p.practiceLine}
        </span>
      </Link>
    </div>
  );
}

/** C: a full-width two-line money button (what you put in, who is waiting), two equal ghost buttons under it. */
function CtaPaired(p: Props & { waiting: number | null }) {
  return (
    <div className="ctaC">
      <button type="button" className="cut cut-btn btn money lg ctaC-play" onClick={p.onPlay}>
        <span className="ctaC-label">Play now</span>
        <span className="ctaC-sub">
          {fmtGemas(p.entry)} Gemas
          {p.waiting ? (
            <>
              {" · "}
              <Users aria-hidden="true" /> {p.waiting} waiting
            </>
          ) : null}
        </span>
      </button>
      <div className="ctaC-row">
        <button type="button" className="cut cut-btn btn neutral ctaC-ghost" onClick={p.onChallenge}>
          <UserPlus aria-hidden="true" />
          Challenge<span className="gp-friend"> a friend</span>
        </button>
        <Link href={p.practiceHref} className="cut cut-btn btn neutral ctaC-ghost">
          <Dumbbell aria-hidden="true" />
          Practice free
        </Link>
      </div>
    </div>
  );
}
