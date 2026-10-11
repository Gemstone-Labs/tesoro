import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/games/block-puzzle/block-puzzle.css";
import "@/app/(app)/wallet/opening/opening.css";
import "@/app/(app)/backing/backing.css";
import "@/games/holdem/holdem.css";
import "@/games/trading-duel/trading.css";
import "@/games/fx/fx.css";
import { LoaderCircle } from "lucide-react";
import { Lab, type Spec } from "./lab";

const B = "src/games/block-puzzle/block-puzzle.css";
const H = "src/games/holdem/holdem.css";
const T = "src/games/trading-duel/trading.css";
const F = "src/games/fx/fx.css";

const specs: Spec[] = [
  {
    name: "bpx-spin",
    file: B,
    line: 33,
    note: "The ring beside 'Finding opponent' while a Match waits to be paired.",
    dur: 1000,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <i className="bpx-spin" style={s} aria-hidden="true" />,
  },
  {
    name: "bp-pop",
    file: B,
    line: 163,
    note: "A block flashing bright, then spinning small and away when its line clears.",
    dur: 380,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="bp-cell k1 on pop" style={{ ...s, width: 56, ["--bev" as string]: "5px" }} />,
  },
  {
    name: "bp-rise",
    file: B,
    line: 115,
    note: "The '+40' that floats up from the board after a clear. Gem clears show it in emerald.",
    dur: 800,
    ease: "ease-out",
    iter: 1,
    fill: "forwards",
    stage: (s) => (
      <span className="bp-popup gem" style={s}>
        +40
      </span>
    ),
  },
  {
    name: "score-bump",
    file: B,
    line: 147,
    note: "The score swelling when it goes up.",
    dur: 320,
    ease: "cubic-bezier(0.2, 1.6, 0.4, 1)",
    iter: 1,
    stage: (s) => (
      <span className="bp-score-n tnum bump" style={s}>
        1,240
      </span>
    ),
  },
  {
    name: "op-spin",
    file: "src/app/(app)/wallet/opening/opening.css",
    line: 20,
    note: "The spinner on the current step when an ETH Position is opening.",
    dur: 1400,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <LoaderCircle className="op-spin" style={{ ...s, width: 40, height: 40 }} aria-hidden="true" />,
  },
  {
    name: "bp-drop",
    file: B,
    line: 151,
    note: "A placed piece dropping into its cells and settling.",
    dur: 420,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1.2)",
    iter: 1,
    stage: (s) => <span className="bp-cell k2 on drop" style={{ ...s, width: 56, ["--bev" as string]: "5px" }} />,
  },
  {
    name: "bp-hint",
    file: B,
    line: 160,
    note: "Cells of a row or column the held piece would complete, pulsing in its colour.",
    dur: 700,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="bp-cell k1 on hint" style={{ ...s, width: 56, ["--hk" as string]: "#3fc6ff", ["--bev" as string]: "5px", animationDirection: "alternate" }} />,
  },
  {
    name: "bp-sweep-x",
    file: B,
    line: 171,
    note: "A white light running along a row that just cleared.",
    dur: 520,
    ease: "ease-out",
    iter: 1,
    stage: (s) => (
      <div style={{ position: "relative", width: 240, height: 120, background: "var(--surface-2)" }}>
        <span className="bp-sweep row" style={{ ...s, ["--at" as string]: 3 }} />
      </div>
    ),
  },
  {
    name: "bp-sweep-y",
    file: B,
    line: 172,
    note: "The same light running down a column that just cleared.",
    dur: 520,
    ease: "ease-out",
    iter: 1,
    stage: (s) => (
      <div style={{ position: "relative", width: 240, height: 120, background: "var(--surface-2)" }}>
        <span className="bp-sweep col" style={{ ...s, ["--at" as string]: 3 }} />
      </div>
    ),
  },
  {
    name: "bpx-flame",
    file: B,
    line: 185,
    note: "The combo meter pips flickering at the hottest heat.",
    dur: 520,
    ease: "ease-in-out",
    iter: "infinite",
    target: "s",
    stage: () => (
      <span className="bpx-combo" data-heat="4">
        <i className="bpx-combo-m" aria-hidden="true">
          <s />
          <s />
          <s />
          <s />
        </i>
      </span>
    ),
  },
  {
    name: "bpx-fizzle",
    file: B,
    line: 188,
    note: "The combo number kicking when a move clears nothing and the chain breaks.",
    dur: 600,
    ease: "ease-out",
    iter: 1,
    target: "b",
    stage: () => (
      <span className="bpx-combo fizzle" style={{ padding: 24 }}>
        <b className="tnum">×0</b>
      </span>
    ),
  },
  {
    name: "bpx-fizzle-ring",
    file: B,
    line: 189,
    note: "The ring that spreads from the combo when the chain breaks.",
    dur: 600,
    ease: "ease-out",
    iter: 1,
    target: ".bpx-combo::after",
    stage: () => (
      <span className="bpx-combo fizzle" style={{ padding: 24 }}>
        <b className="tnum">×0</b>
      </span>
    ),
  },
  {
    name: "bp-deal",
    file: B,
    line: 192,
    note: "A new piece sliding up into the tray.",
    dur: 360,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1.15)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="bp-deal" style={s}><i className="bp-cell k3 on" style={{ width: 48, height: 48, ["--bev" as string]: "5px" }} /></span>,
  },
  {
    name: "bpx-pulse",
    file: B,
    line: 210,
    note: "The timer ring swelling and glowing amber in the last 10 seconds.",
    dur: 1000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span style={{ ...s, display: "block", width: 56, height: 56, border: "4px solid var(--warn)", borderRadius: "50%" }} />,
  },
  {
    name: "bp-edge",
    file: B,
    line: 212,
    note: "The board edge pulsing amber in the last 10 seconds.",
    dur: 1000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <div className="bp-board low" style={{ ...s, width: 140, height: 140 }} />,
  },
  {
    name: "bp-best",
    file: B,
    line: 216,
    note: "The 'New best!' line popping in on the game-over card.",
    dur: 700,
    ease: "cubic-bezier(0.2, 1.6, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="bp-best new" style={{ ...s, animationDelay: "0ms" }}>New best!</span>,
  },
  {
    name: "bp-stat",
    file: B,
    line: 221,
    note: "A run stat plaque rising in on the game-over card.",
    dur: 380,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1.1)",
    iter: 1,
    fill: "both",
    stage: (s) => (
      <span className="cut" style={{ ...s, display: "grid", padding: "10px 24px", background: "var(--surface)" }}>
        <b className="tnum">12</b>
        <span>Lines</span>
      </span>
    ),
  },
  {
    name: "fx-callout",
    file: F,
    line: 64,
    note: "The punchy line over a board ('Double!', 'Long 5x opened'): scales in, holds, floats off.",
    dur: 1100,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="cut fx-callout up" style={s}>Long 5x</span>,
  },
  {
    name: "fx-count",
    file: F,
    line: 75,
    note: "The big 3-2-1 before a round; Go! is the same motion in sapphire.",
    dur: 800,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="fx-count-n" style={{ ...s, fontSize: 72 }}>3</span>,
  },
  {
    name: "hd-sweep",
    file: H,
    line: 70,
    note: "A Chip flying from a bet to the pot, or from the pot to the winner.",
    dur: 620,
    ease: "cubic-bezier(0.5, 0, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span style={{ ...s, display: "block", width: 28, height: 28, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #fff, #8aa0bd 70%)", ["--dx" as string]: "90px", ["--dy" as string]: "-20px" }} />,
  },
  {
    name: "hd-glow",
    file: H,
    line: 97,
    note: "The turn ring glow round the avatar of whoever must act.",
    dur: 1600,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="hd-ava active" style={s}><span className="hd-ava-img" style={{ display: "block" }} /></span>,
  },
  {
    name: "hd-pop",
    file: H,
    line: 105,
    note: "The dealer button popping in at a new seat.",
    dur: 360,
    ease: "cubic-bezier(0.2, 1.4, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span style={{ ...s, display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: "50%", background: "#e6ebf2", color: "#0a1226", fontWeight: 900 }}>D</span>,
  },
  {
    name: "hd-win-in",
    file: H,
    line: 148,
    note: "The showdown result plaque and the turn tag rising in once the cards are shown.",
    dur: 520,
    ease: "cubic-bezier(0.2, 1.1, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="cut" style={{ ...s, padding: "8px 22px", background: "var(--surface)" }}>You win 40 Chips</span>,
  },
  {
    name: "td-flash-up",
    file: T,
    line: 135,
    note: "The price flashing sapphire on an upward tick.",
    dur: 700,
    ease: "ease-out",
    iter: 1,
    stage: (s) => <b className="mono td-big" style={s}>$142.30 ▲</b>,
  },
  {
    name: "td-flash-down",
    file: T,
    line: 136,
    note: "The price flashing amber on a downward tick.",
    dur: 700,
    ease: "ease-out",
    iter: 1,
    stage: (s) => <b className="mono td-big" style={s}>$142.10 ▼</b>,
  },
  {
    name: "td-pulse",
    file: T,
    line: 147,
    note: "The halo breathing around the live head of the chart line.",
    dur: 1600,
    ease: "ease-out",
    iter: "infinite",
    stage: (s) => (
      <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true">
        <circle className="td-pulse" style={s} cx="40" cy="40" r="6" />
      </svg>
    ),
  },
  {
    name: "td-ripple",
    file: T,
    line: 153,
    note: "The ring spreading over the chart when a position opens, closes or is liquidated.",
    dur: 1200,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => (
      <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true">
        <circle className="td-ripple up" style={s} cx="40" cy="40" r="6" />
      </svg>
    ),
  },
  {
    name: "td-danger",
    file: T,
    line: 160,
    note: "The liquidation meter pulsing once the position is close to liquidation.",
    dur: 800,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => (
      <div className="td-liqmeter danger" style={{ width: 240 }}>
        <div className="td-liqmeter-bar">
          <i style={{ ...s, width: "20%", animationDirection: "alternate" }} />
        </div>
      </div>
    ),
  },
  {
    name: "td-duel-pulse",
    file: T,
    line: 173,
    note: "The Duel marker kicking when the lead changes hands.",
    dur: 900,
    ease: "ease-out",
    iter: 1,
    stage: (s) => (
      <div className="td-duel-track" style={{ width: 240 }}>
        <i style={{ ...s, left: "50%" }} />
      </div>
    ),
  },
  {
    name: "td-final",
    file: T,
    line: 179,
    note: "The big amber seconds in the last 10 of a round.",
    dur: 1000,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => (
      <div className="td-final" style={{ position: "relative", right: "auto", top: "auto" }}>
        <span style={s}>10</span>
      </div>
    ),
  },
];

const meta = {
  title: "Motion/Game and wallet keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="Block Puzzle, Hold'em and Trading Duel feel effects (with the shared callout and countdown), the Position opening steps and the Backing drawer." />,
};
