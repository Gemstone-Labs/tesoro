import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/components/match/match.css";
import "@/components/guide/guide.css";
import { Bust, GemaMark } from "@/components/ui";
import { Lab, Sample, type Spec } from "./lab";

const M = "src/components/match/match.css";
const G = "src/components/guide/guide.css";

const rays = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  const p = (ang: number) => `${300 + Math.cos(ang) * 280},${150 + Math.sin(ang) * 140}`;
  return <polygon key={i} points={`300,150 ${p(a - 0.1)} ${p(a + 0.1)}`} fill="#63f7d3" opacity={0.28} />;
});

const specs: Spec[] = [
  {
    name: "mo-in",
    file: M,
    line: 64,
    note: "The win overlay fading in (260 ms). It runs together with mo-out.",
    dur: 260,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => <Sample style={s}>Overlay</Sample>,
  },
  {
    name: "mo-out",
    file: M,
    line: 65,
    note: "The overlay fading out after 2.68 s, ending the 3 s moment.",
    dur: 320,
    ease: "ease-in",
    delay: 400,
    iter: 1,
    fill: "forwards",
    stage: (s) => <Sample style={s}>Overlay</Sample>,
  },
  {
    name: "mo-pop",
    file: M,
    line: 66,
    note: "The Player's bust popping up in the win overlay.",
    dur: 420,
    ease: "cubic-bezier(0.2, 1.4, 0.4, 1)",
    iter: 1,
    fill: "both",
    stage: () => <Bust name="himWin" width={120} className="mo-bust" priority />,
    target: ".mo-bust",
  },
  {
    name: "burst-breathe",
    file: M,
    line: 84,
    note: "The light behind a won amount breathing on the result.",
    dur: 4500,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => (
      <svg className="mr-burst" viewBox="0 0 600 300" width={260} style={s} aria-hidden="true">
        {rays}
      </svg>
    ),
  },
  {
    name: "gema-land",
    file: M,
    line: 86,
    note: "The Gema mark landing beside a won amount.",
    dur: 700,
    ease: "cubic-bezier(0.2, 1.4, 0.4, 1)",
    iter: 1,
    fill: "both",
    target: ".gema-mark",
    stage: () => (
      <span className="mr-amount won" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 28, fontWeight: 800 }}>
        <GemaMark size={36} /> +900
      </span>
    ),
  },
  {
    name: "guide-dim",
    file: G,
    line: 37,
    note: "The page dimming when the Guide appears.",
    dur: 360,
    ease: "ease-out",
    iter: 1,
    fill: "both",
    stage: (s) => <Sample style={s}>Dimmed page</Sample>,
  },
  {
    name: "guide-rise",
    file: G,
    line: 38,
    note: "The Guide character stepping in from the bottom right.",
    dur: 700,
    ease: "cubic-bezier(0.2, 1, 0.3, 1)",
    delay: 100,
    iter: 1,
    fill: "both",
    stage: () => <Bust name="himExplain" width={140} className="guide-bust-demo" />,
    target: "img",
  },
  {
    name: "guide-pop",
    file: G,
    line: 39,
    note: "The speech bubble popping in after the character.",
    dur: 420,
    ease: "cubic-bezier(0.2, 1.3, 0.4, 1)",
    delay: 560,
    iter: 1,
    fill: "both",
    stage: (s) => (
      <div className="cut cut-card" style={{ ...s, padding: "10px 14px", transformOrigin: "100% 56px", fontWeight: 700 }}>
        Good to know
      </div>
    ),
  },
];

const meta = {
  title: "Motion/Match and Guide keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="The win overlay, the result's light and the Guide's entrance, one keyframe at a time. The whole sequences are in Motion / Moment overlay and Motion / Guide entrance." />,
};
