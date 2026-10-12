import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { art } from "@/lib/art";
import { GridScreen, type GridPoint } from "@/games/trading-duel/GridScreen";
import { COLUMNS, MATCH_SECS, NO_PICK, STEP_PPM, finish, newTrack, record, revealed, bandOf, stepFor, type Track } from "@/games/trading-duel/grid";
import { seededRng } from "@/games/trading-duel/practice/bot";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";

const START = 1_800_000_000_000;
const ANCHOR = 142_50000000n;
const STEP = stepFor(ANCHOR, STEP_PPM.SOL);

/** A made-up SOL walk, one price a second, from the same seed every time. `trend` adds a steady climb per second (a fast day). */
function walk(seed: number, secs: number, trend = 0) {
  const rng = seededRng(seed);
  let p = Number(ANCHOR) / 1e8;
  let drift = trend;
  const series: GridPoint[] = [];
  let track: Track = record(newTrack(), 0, ANCHOR);
  for (let s = 1; s <= Math.min(secs, MATCH_SECS); s++) {
    drift = drift * 0.9 + (rng() - 0.5) * 0.00003 + trend;
    p *= 1 + drift + (rng() - 0.5) * 0.00012;
    const mid = BigInt(Math.round(p * 1e8));
    series.push({ t: START + s * 1000, p });
    track = s >= MATCH_SECS ? finish(track) : record(track, s, mid);
  }
  return { series, track, price: BigInt(Math.round(p * 1e8)) };
}

/** Picks: `hit` columns get a band the line crossed, `miss` columns a band it did not, anything else is left empty. */
function picksFor(track: Track, plan: ("hit" | "miss" | "-")[]): number[] {
  return plan.map((x, c) => {
    if (x === "-" || !track.seen[c]) return x === "-" ? NO_PICK : 0;
    const lo = bandOf(track.lo[c], ANCHOR, STEP);
    const hi = bandOf(track.hi[c], ANCHOR, STEP);
    if (x === "hit") return lo;
    return hi + 3;
  });
}

const H = "hit";
const M = "miss";
const N = "-";
const PLANS = {
  won: { me: [H, H, M, H, H, H, M, H, H, N, H, H], foe: [M, H, H, M, H, M, H, M, H, H, M, M] },
  lost: { me: [M, H, M, H, M, M, H, M, N, H, M, H], foe: [H, H, H, M, H, H, H, M, H, H, H, M] },
  draw: { me: [H, M, H, H, M, H, M, H, M, H, M, H], foe: [M, H, H, M, H, H, H, M, H, M, H, M] },
} as const;

interface Args {
  t: number;
  plan: keyof typeof PLANS | "open";
  /** Hand-pick boxes by tapping (the clock stays frozen). */
  playable?: boolean;
  /** A real Match: entry and Pot in Gemas instead of the practice note. */
  staked?: boolean;
  /** A steady climb per second, as a fraction of the price: the line leaves the start price far behind. */
  trend?: number;
}

function Screen({ t, plan, playable, staked, trend }: Args) {
  const { series, track } = walk(7, t, trend);
  const planned = plan === "open" ? null : PLANS[plan];
  const [taps, setTaps] = useState<number[]>(() =>
    planned ? picksFor(track, [...planned.me]) : Array.from({ length: COLUMNS }, (_, c) => (c < 3 + Math.floor(t / 10) ? [-1, 0, 1, -1, -2, 0, 1, -1, 0][c % 9] : NO_PICK)),
  );
  const foePicks = planned ? picksFor(track, [...planned.foe]) : Array.from({ length: COLUMNS }, (_, c) => [0, -1, 1, 2, -2, 0, -1, 1, 0, -1, 1, 0][c]);
  const done = t >= MATCH_SECS;
  const score = (picks: number[]) => picks.filter((r, c) => r !== NO_PICK && track.seen[c] && bandOf(track.lo[c], ANCHOR, STEP) <= r && r <= bandOf(track.hi[c], ANCHOR, STEP)).length * 100;
  return (
    <GridScreen
      asset="SOL"
      anchor={ANCHOR}
      step={STEP}
      startsAt={START}
      nowMs={START + t * 1000}
      track={track}
      series={series}
      mine={taps}
      theirs={revealed(foePicks, t)}
      me={{ name: "You", avatar: art.avatars[0] }}
      opponent={{ name: "Bot", avatar: art.avatars[4] }}
      final={done ? { you: score(taps), them: score(foePicks) } : null}
      practice={!staked}
      entry={staked ? 1000 : undefined}
      pot={staked ? 1900 : undefined}
      onPick={(c, r) => (playable || !done) && setTaps((p) => p.map((x, i) => (i === c ? r : x)))}
      onPlayAgain={() => undefined}
      exitHref="/lobby"
    />
  );
}

const meta = {
  title: "Games/Trading Grid",
  parameters: { layout: "padded", shell: "app" },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const at = (t: number, plan: Args["plan"] = "open", trend = 0): Story => ({ args: { t, plan, trend }, render: (a) => <Screen key={`${a.t}${a.plan}${a.trend}`} {...a} /> });
const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/** Head start: nothing has happened yet, the first columns are open. Tap a box to pick it, tap it again to clear it. */
export const HeadStart = at(12);
export const HeadStartPhone = phone(at(12));
/** Mid game: some columns done (hits and misses), one live, one locked with the opponent's pick revealed, the rest open. */
export const MidGame = at(84, "won");
export const MidGamePhone = phone(at(84, "won"));
/** The last ten seconds. */
export const LastColumn = at(144, "won");
/** The end screens. */
export const EndWon = at(151, "won");
export const EndLost = at(151, "lost");
export const EndDraw = at(151, "draw");
export const EndWonStaked: Story = { args: { t: 151, plan: "won", staked: true }, render: (a) => <Screen key="staked" {...a} /> };
export const EndWonPhone = phone(at(151, "won"));

/** A fast day: the line has climbed about thirty bands from the start price and the view follows it. Pan up and down to look back; picks left behind show as edge markers. */
export const FastClimb = at(84, "open", 0.0004);
export const FastClimbPhone = phone(at(84, "open", 0.0004));

/** Practice against the bot on the live price. */
export const PlayPractice: StoryObj = { render: () => <TradingDuelPractice /> };
