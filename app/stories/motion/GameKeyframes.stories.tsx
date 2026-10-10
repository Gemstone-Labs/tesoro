import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/games/block-puzzle/block-puzzle.css";
import "@/app/(app)/wallet/opening/opening.css";
import "@/app/(app)/backing/backing.css";
import { LoaderCircle } from "lucide-react";
import { Lab, type Spec } from "./lab";

const B = "src/games/block-puzzle/block-puzzle.css";

const specs: Spec[] = [
  {
    name: "bpx-spin",
    file: B,
    line: 32,
    note: "The ring beside 'Finding opponent' while a Match waits to be paired.",
    dur: 1000,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <i className="bpx-spin" style={s} aria-hidden="true" />,
  },
  {
    name: "bp-pop",
    file: B,
    line: 103,
    note: "A block flashing bright and shrinking away when its line clears.",
    dur: 320,
    ease: "ease-out",
    iter: 1,
    fill: "forwards",
    stage: (s) => <span className="bp-cell k1 on pop" style={{ ...s, width: 56, ["--bev" as string]: "5px" }} />,
  },
  {
    name: "bp-rise",
    file: B,
    line: 114,
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
    line: 146,
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
];

const meta = {
  title: "Motion/Game and wallet keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="Block Puzzle's board effects, the Position opening steps and the Backing drawer." />,
};
