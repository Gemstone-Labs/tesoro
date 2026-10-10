"use client";

// PROTOTYPE: variants of the hero slide's "N waiting in Queue · Challenge a friend" line.
// Five variants on /lobby, switchable via ?variant=A..E and the floating bar (← / → keys).
// Throwaway: lives on proto/lobby-hero-meta-10-10-2026 only. Per-entry split, avatars and
// wait times are MOCK (the chain read only gives a total count per Game).
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Link2, Swords, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui";
import { ENTRY_SIZES } from "@/components/ui/inputs";
import { avatarFor } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import type { EntrySize, GameId } from "@/lib/mock";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import "./hero-meta.prototype.css";

export const META_VARIANTS = [
  { key: "A", name: "Current" },
  { key: "B", name: "Live strip" },
  { key: "C", name: "Two doors" },
  { key: "D", name: "Queue by entry" },
  { key: "E", name: "Mode toggle" },
];

export function useMetaVariant() {
  return useSearchParams().get("variant") ?? "A";
}

/** MOCK: ?waiting=N overrides the live Queue count so the busy state can be judged. */
export function useWaitingOverride(real: number) {
  const w = useSearchParams().get("waiting");
  return w === null ? real : Number(w);
}

export function HeroMetaSwitcher() {
  return <PrototypeSwitcher variants={META_VARIANTS} />;
}

/** MOCK: split the real total over the three entries, biggest share on the default entry. */
export function mockSplit(total: number, game: GameId): Record<EntrySize, number> {
  const out = { 500: 0, 1000: 0, 2500: 0 } as Record<EntrySize, number>;
  const order: EntrySize[] = game === "block-puzzle" ? [1000, 500, 2500] : [500, 1000, 2500];
  const pattern = [0, 1, 0, 2];
  for (let i = 0; i < total; i++) out[order[pattern[i % 4]]]++;
  return out;
}

const waitFor = (n: number) => (n === 0 ? "Be the first in" : "Match in seconds");

interface Props {
  game: GameId;
  title: string;
  entry: EntrySize;
  waiting: number;
  onPlay: () => void;
  onChallenge: () => void;
}

function Faces({ game, n, size = 26 }: { game: GameId; n: number; size?: number }) {
  const shown = Math.min(n, 3);
  return (
    <span className="hm-faces" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <Image key={i} src={avatarFor(`${game}-waiting-${i}`)} alt="" width={size} height={size} />
      ))}
      {n > 3 && <b>+{n - 3}</b>}
      {n === 0 && <i className="hm-empty-seat" />}
    </span>
  );
}

/* B — Live strip: one framed status bar under Play now. Faces + count on the left, Challenge as a neutral button on the right. */
export function MetaLiveStrip({ game, waiting, onPlay, onChallenge }: Props) {
  return (
    <>
      <Button variant="money" size="lg" block onClick={onPlay}>
        Play now
      </Button>
      <div className="cut hm-strip">
        <span className="hm-live" aria-hidden="true" />
        <Faces game={game} n={waiting} />
        <span className="hm-strip-text">
          <strong>{waiting === 0 ? "Queue is open" : `${waiting} waiting`}</strong>
          <small>{waitFor(waiting)}</small>
        </span>
        <button type="button" className="cut cut-btn btn sm hm-strip-btn" onClick={onChallenge}>
          <Swords aria-hidden="true" /> Challenge a friend
        </button>
      </div>
    </>
  );
}

/* C — Two doors: the Queue count lives inside Play now; Challenge is a peer button beside it. No meta line. */
export function MetaTwoDoors({ waiting, onPlay, onChallenge }: Props) {
  return (
    <div className="hm-doors">
      <button type="button" className="cut cut-btn btn money lg hm-door-main" onClick={onPlay}>
        <span>Play now</span>
        <small>
          <span className="hm-live dark" aria-hidden="true" /> {waiting === 0 ? "Queue is open" : `${waiting} waiting now`}
        </small>
      </button>
      <button type="button" className="cut cut-btn btn lg hm-door-side" onClick={onChallenge}>
        <Swords aria-hidden="true" />
        <span>Challenge</span>
        <small>a friend</small>
      </button>
    </div>
  );
}

/* D — Queue by entry: the count moves onto the entry choice it belongs to (row above the chips). */
export function EntryQueueRow({ game, waiting, entry }: { game: GameId; waiting: number; entry: EntrySize }) {
  const split = mockSplit(waiting, game);
  return (
    <div className="hm-entry-row" aria-label="Players waiting at each entry">
      {ENTRY_SIZES.map((s) => (
        <span key={s} className={s === entry ? "on" : undefined}>
          {split[s] > 0 ? (
            <>
              <span className="hm-live" aria-hidden="true" />
              {split[s]} waiting
            </>
          ) : (
            "Open"
          )}
        </span>
      ))}
    </div>
  );
}

export function MetaByEntry({ game, waiting, entry, onPlay, onChallenge }: Props) {
  const n = mockSplit(waiting, game)[entry];
  return (
    <>
      <Button variant="money" size="lg" block onClick={onPlay}>
        Play now
      </Button>
      <p className="hm-byentry">
        {n > 0 ? (
          <span>
            <Zap aria-hidden="true" /> {n} {n === 1 ? "Player" : "Players"} at {fmtGemas(entry)}: you play right away
          </span>
        ) : (
          <span>
            <Users aria-hidden="true" /> No one at {fmtGemas(entry)} yet: you open the Match
          </span>
        )}
        <button type="button" onClick={onChallenge}>
          <Link2 aria-hidden="true" /> Challenge a friend
        </button>
      </p>
    </>
  );
}

/* E — Mode toggle: pick how you find an opponent first, then one CTA. */
export function MetaModeToggle({ game, waiting, entry, onPlay, onChallenge }: Props) {
  const [mode, setMode] = useState<"queue" | "friend">("queue");
  return (
    <>
      <div className="cut hm-modes" role="radiogroup" aria-label="Opponent">
        <button type="button" role="radio" aria-checked={mode === "queue"} className={mode === "queue" ? "on" : undefined} onClick={() => setMode("queue")}>
          <span>Quick Match</span>
          <small>
            <Faces game={game} n={waiting} size={18} /> {waiting} waiting
          </small>
        </button>
        <button type="button" role="radio" aria-checked={mode === "friend"} className={mode === "friend" ? "on" : undefined} onClick={() => setMode("friend")}>
          <span>Challenge a friend</span>
          <small>
            <Link2 aria-hidden="true" /> Send them a link
          </small>
        </button>
      </div>
      <Button variant="money" size="lg" block onClick={mode === "queue" ? onPlay : onChallenge}>
        {mode === "queue" ? "Play now" : `Create Challenge · ${fmtGemas(entry)}`}
      </Button>
    </>
  );
}
