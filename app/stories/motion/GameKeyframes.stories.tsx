import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/games/block-puzzle/block-puzzle.css";
import "@/app/(app)/wallet/opening/opening.css";
import "@/app/(app)/backing/backing.css";
import "@/games/holdem/holdem.css";
import "@/games/trading-duel/grid.css";
import "@/games/fx/fx.css";
import { LoaderCircle } from "lucide-react";
import { Lab, type Spec } from "./lab";

const B = "src/games/block-puzzle/block-puzzle.css";
const H = "src/games/holdem/holdem.css";
const G = "src/games/trading-duel/grid.css";
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
    line: 143,
    note: "A block flashing bright, then spinning small and away when its line clears.",
    dur: 380,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="bp-cell k1 on pop" style={{ ...s, width: 56, ["--bev" as string]: "5px" }} />,
  },
  {
    name: "op-spin",
    file: "src/app/(app)/wallet/opening/opening.css",
    line: 47,
    note: "The spinner on the current step when an ETH Position is opening.",
    dur: 1400,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <LoaderCircle className="op-spin" style={{ ...s, width: 40, height: 40 }} aria-hidden="true" />,
  },
  {
    name: "bp-drop",
    file: B,
    line: 131,
    note: "A placed piece dropping into its cells and settling.",
    dur: 420,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1.2)",
    iter: 1,
    stage: (s) => <span className="bp-cell k2 on drop" style={{ ...s, width: 56, ["--bev" as string]: "5px" }} />,
  },
  {
    name: "bp-hint",
    file: B,
    line: 140,
    note: "Cells of a row or column the held piece would complete, pulsing in its colour.",
    dur: 700,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="bp-cell k1 on hint" style={{ ...s, width: 56, ["--hk" as string]: "#3fc6ff", ["--bev" as string]: "5px", animationDirection: "alternate" }} />,
  },
  {
    name: "bp-sweep-x",
    file: B,
    line: 151,
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
    line: 152,
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
    line: 165,
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
    line: 168,
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
    line: 169,
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
    line: 172,
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
    line: 190,
    note: "The timer ring swelling and glowing amber in the last 10 seconds.",
    dur: 1000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span style={{ ...s, display: "block", width: 56, height: 56, border: "4px solid var(--warn)", borderRadius: "50%" }} />,
  },
  {
    name: "bp-edge",
    file: B,
    line: 192,
    note: "The board edge pulsing amber in the last 10 seconds.",
    dur: 1000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <div className="bp-board low" style={{ ...s, width: 140, height: 140 }} />,
  },
  {
    name: "bp-best",
    file: B,
    line: 196,
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
    line: 201,
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
    line: 57,
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
    line: 68,
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
    line: 149,
    note: "The showdown result plaque and the turn tag rising in once the cards are shown.",
    dur: 520,
    ease: "cubic-bezier(0.2, 1.1, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="cut" style={{ ...s, padding: "8px 22px", background: "var(--surface)" }}>You win 40 Chips</span>,
  },
  {
    name: "tg-score",
    file: G,
    line: 36,
    note: "A score jumping when a hit lands.",
    dur: 520,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1)",
    iter: 1,
    stage: (s) => <b className="tg tg-score" style={{ ...s, display: "block", width: "auto", fontSize: 48 }}>300</b>,
  },
  {
    name: "tg-pop",
    file: G,
    line: 138,
    note: "Your pick popping into a box.",
    dur: 420,
    ease: "cubic-bezier(0.2, 1.4, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="tg" style={{ width: "auto" }}><span className="tg-mark me" style={{ ...s, position: "relative", display: "grid", width: 36, height: 36, placeItems: "center" }}>▲</span></span>,
  },
  {
    name: "tg-flip",
    file: G,
    line: 139,
    note: "The opponent's pick turning over when its column locks.",
    dur: 520,
    ease: "cubic-bezier(0.2, 0.9, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="tg" style={{ width: "auto" }}><span className="tg-mark foe" style={{ ...s, position: "relative", display: "grid", width: 36, height: 36, placeItems: "center" }}>▲</span></span>,
  },
  {
    name: "tg-hit",
    file: G,
    line: 140,
    note: "A pick swelling when the line passes through its box.",
    dur: 700,
    ease: "cubic-bezier(0.2, 1.4, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="tg" style={{ width: "auto" }}><span className="tg-mark me hit" style={{ ...s, position: "relative", display: "grid", width: 36, height: 36, placeItems: "center" }}>✓</span></span>,
  },
  {
    name: "tg-live",
    file: G,
    line: 133,
    note: "A pick glowing while the line is in its column and has not reached the box yet.",
    dur: 1200,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="tg" style={{ width: "auto" }}><span className="tg-mark me" style={{ ...s, position: "relative", display: "grid", width: 36, height: 36, placeItems: "center" }}>▲</span></span>,
  },
  {
    name: "tg-beat",
    file: G,
    line: 158,
    note: "The glowing diamond at the head of the price line.",
    dur: 1100,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="tg" style={{ width: 60, height: 40 }}><i className="tg-head-dot" style={{ ...s, left: 21, top: 11 }} /></span>,
  },
  {
    name: "tg-nag",
    file: G,
    line: 113,
    note: "An open column flashing amber just before it locks with no pick in it.",
    dur: 800,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span style={{ ...s, display: "block", width: 120, padding: "10px 0", textAlign: "center", background: "rgba(242, 166, 59, 0.14)" }}>Column 7</span>,
  },
  {
    name: "tg-last",
    file: G,
    line: 67,
    note: "The countdown strip pulsing in the last ten seconds.",
    dur: 1000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="tg" style={{ width: "auto" }}><span className="cut tg-strip last" style={{ ...s, padding: "10px 18px", display: "block" }}>Last ten seconds</span></span>,
  },
  {
    name: "tg-float",
    file: G,
    line: 166,
    note: "The +100 rising from a box on a hit.",
    dur: 1200,
    ease: "cubic-bezier(0.2, 0.8, 0.3, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="tg" style={{ width: 80, height: 70 }}><span className="tg-float" style={{ ...s, left: 14, bottom: 4 }}>+100</span></span>,
  },
  {
    name: "tg-rise",
    file: G,
    line: 172,
    note: "The end screen panel rising in over the faded grid.",
    dur: 520,
    ease: "cubic-bezier(0.2, 1.2, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => <span className="cut" style={{ ...s, padding: "8px 22px", background: "var(--surface)" }}>You won</span>,
  },
];

const meta = {
  title: "Motion/Game and wallet keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="Block Burst, Hold'em and Trading Duel feel effects (with the shared callout and countdown), the Position opening steps and the Backing drawer." />,
};
