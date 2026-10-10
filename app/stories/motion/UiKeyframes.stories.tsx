import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Button, GemaMark } from "@/components/ui";
import { Lab, Sample, ScrollBox, type Spec } from "./lab";

const F = "src/components/ui/ui.css";

const specs: Spec[] = [
  {
    name: "glint",
    file: F,
    line: 149,
    note: "The light that crosses a Gema mark now and then (GemaMark with glint).",
    dur: 3200,
    ease: "ease-in-out",
    iter: "infinite",
    target: ".shine",
    stage: () => <GemaMark size={72} glint />,
  },
  {
    name: "sheet-in",
    file: F,
    line: 289,
    note: "A sheet rising in. Phones: from the bottom edge. The real Sheet is in Motion / Sheet and drawers.",
    dur: 320,
    ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    iter: 1,
    stage: (s) => <Sample style={s}>Sheet</Sample>,
  },
  {
    name: "fade-in",
    file: F,
    line: 290,
    note: "The dimmed ground behind a sheet or drawer.",
    dur: 240,
    ease: "ease-out",
    iter: 1,
    stage: (s) => <Sample style={s}>Backdrop</Sample>,
  },
  {
    name: "spin",
    file: F,
    line: 331,
    note: "The small spinner next to every wait (Busy, buttons, Finding opponent).",
    dur: 800,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <span className="spinner" style={s} />,
  },
  {
    name: "skel",
    file: F,
    line: 375,
    note: "The light that runs over a loading skeleton, shaped like what is coming.",
    dur: 1600,
    ease: "ease-in-out",
    iter: "infinite",
    target: ".skel::before",
    stage: () => (
      <div className="cut cut-card skel player" style={{ width: 280, padding: 14 }}>
        <span className="cut skel-av" />
        <span className="skel-lines">
          <i className="skel-line lg" />
          <i className="skel-line" />
        </span>
      </div>
    ),
  },
  {
    name: "btn-sweep",
    file: F,
    line: 385,
    note: "The light that crosses the big money button every few seconds. The delay is its wait before the first pass.",
    dur: 6000,
    ease: "ease-in-out",
    delay: 1600,
    iter: "infinite",
    target: ".btn.money.lg::before",
    stage: () => (
      <Button variant="money" size="lg">
        Play now
      </Button>
    ),
  },
  {
    name: "reveal",
    file: F,
    line: 392,
    note: "Lists and grids rise in as they scroll into view (Lobby rails, Backing cards, Wallet grid). Scroll the box.",
    dur: 0,
    ease: "linear",
    iter: 1,
    scroll: true,
    stage: () => (
      <ScrollBox rows={0}>
        {Array.from({ length: 9 }, (_, i) => (
          <div
            key={i}
            className="sbm-scroll-item"
            style={{ animation: "reveal linear both", animationTimeline: "view()", animationRange: "entry 0% entry 30%" }}
          >
            Card {i + 1}
          </div>
        ))}
      </ScrollBox>
    ),
  },
];

const meta = {
  title: "Motion/UI keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="Every animation in ui.css, on the element that uses it. Change the timing and press Replay." />,
};

