import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { Glints, Motes } from "@/components/landing/Fx";
import { Lab, ScrollBox, type Spec } from "./lab";

const L = "src/components/landing/landing.css";
const mid = (s: CSSProperties, more: CSSProperties = {}): CSSProperties => ({ ...s, left: "50%", top: "50%", ...more });

const specs: Spec[] = [
  {
    name: "lp-flicker",
    file: L,
    line: 119,
    note: "The lantern glow in the hero flickering. The two lanterns of the closing section use the same keyframes (3.1 s).",
    dur: 2800,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="lp-lantern" style={mid(s, { width: 120 })} />,
  },
  {
    name: "lp-flicker-wide",
    file: L,
    line: 120,
    note: "The wide, faint glow behind the hero lantern.",
    dur: 4600,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="lp-lantern wide" style={mid(s, { width: 260 })} />,
  },
  {
    name: "lp-settle",
    file: L,
    line: 144,
    note: "The hero art settling in from slightly zoomed and dark. The three layers start 0.1 s apart.",
    dur: 1400,
    ease: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    iter: 1,
    fill: "backwards",
    stage: (s) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/art/landing/heroBack-1280.webp" alt="" style={{ ...s, width: "100%", height: "100%", objectFit: "cover" }} />
    ),
  },
  {
    name: "lp-sweep",
    file: L,
    line: 145,
    note: "The light running across the hero headline once, at load.",
    dur: 1800,
    ease: "cubic-bezier(0.3, 0.6, 0.2, 1)",
    delay: 500,
    iter: 1,
    fill: "backwards",
    stage: (s) => (
      <b className="sweep" style={{ ...s, fontSize: 30, ["--hero-fg" as string]: "#eaefec", ["--sweep" as string]: "#ffffff" }}>
        Play now, earn later
      </b>
    ),
  },
  {
    name: "lp-m-flow",
    file: L,
    line: 255,
    note: "Dashes running along the glowing tubes of the phone flow.",
    dur: 1400,
    ease: "linear",
    iter: "infinite",
    stage: (s) => (
      <svg viewBox="0 0 100 48" width={200} height={96} preserveAspectRatio="none" fill="none" aria-hidden>
        <path d="M50 0C50 26 25 22 25 48" stroke="#0b6f55" strokeWidth={9} pathLength={100} vectorEffect="non-scaling-stroke" />
        <path d="M50 0C50 26 25 22 25 48" stroke="#2fdcae" strokeWidth={5} pathLength={100} vectorEffect="non-scaling-stroke" />
        <path d="M50 0C50 26 25 22 25 48" stroke="#fff" strokeWidth={3} strokeDasharray="2 18" pathLength={100} vectorEffect="non-scaling-stroke" style={s} />
      </svg>
    ),
  },
  {
    name: "lp-twinkle",
    file: L,
    line: 299,
    note: "Little diamonds twinkling around the Gema. Each starts at its own time, so the delay is left as built.",
    dur: 3600,
    ease: "ease-in-out",
    iter: "infinite",
    keepDelay: true,
    target: ".lp-sparkles i",
    stage: () => (
      <span className="lp-sparkles" aria-hidden>
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} style={{ ["--i" as string]: i }} />
        ))}
      </span>
    ),
  },
  {
    name: "lp-sheen",
    file: L,
    line: 321,
    note: "On phones, a light that crosses the Gema poster as you scroll past it. Scroll the box.",
    dur: 0,
    ease: "linear",
    iter: 1,
    scroll: true,
    stage: () => (
      <ScrollBox rows={5}>
        <div
          style={{
            flex: "none",
            height: 90,
            margin: 8,
            border: "1px solid var(--line-2)",
            background: "linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.35) 50%, transparent 60%) 0 0 / 250% 100% no-repeat, var(--raised-2)",
            animation: "lp-sheen linear both",
            animationTimeline: "view()",
            animationRange: "cover 20% cover 80%",
          }}
        />
      </ScrollBox>
    ),
  },
  {
    name: "lp-breathe",
    file: L,
    line: 395,
    note: "The empty 'your game' slot in the catalogue breathing.",
    dur: 2800,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => (
      <ul className="lp-catalogue" style={{ gridTemplateColumns: "110px", margin: 0 }}>
        <li className="lp-slot cut cut-card" style={s}>
          <span>Your game</span>
        </li>
      </ul>
    ),
  },
  {
    name: "lp-pulse-arc",
    file: L,
    line: 406,
    note: "The Studio Fee arc in the Pot ring pulsing thicker.",
    dur: 2600,
    ease: "ease-in-out",
    iter: "infinite",
    target: ".studio",
    stage: () => (
      <div className="lp-pot-ring" style={{ width: 120 }} aria-hidden>
        <svg viewBox="0 0 100 100">
          <circle className="track" cx="50" cy="50" r="40" />
          <circle className="win" cx="50" cy="50" r="40" pathLength={100} strokeDasharray="70 30" />
          <circle className="studio" cx="50" cy="50" r="40" pathLength={100} strokeDasharray="12 88" strokeDashoffset={-72} />
        </svg>
      </div>
    ),
  },
  {
    name: "lp-arrive",
    file: L,
    line: 424,
    note: "A Gema running along the path from Gemas to your game (wide screens).",
    dur: 3600,
    ease: "ease-in-out",
    iter: "infinite",
    target: ".lp-arrive-token",
    stage: () => (
      <div className="lp-arrive" aria-hidden style={{ flexWrap: "nowrap", scale: 0.8 }}>
        <span className="lp-arrive-token">
          <GemaMark size={14} />
        </span>
        <span className="lp-pill cut cut-btn">
          <GemaMark size={18} /> Gemas
        </span>
        <ArrowRight />
        <span className="lp-pill cut cut-btn strong">Your game</span>
      </div>
    ),
  },
  {
    name: "lp-arrive-v",
    file: L,
    line: 656,
    note: "The same Gema dropping top to bottom on phones.",
    dur: 3200,
    ease: "cubic-bezier(0.55, 0, 0.6, 1)",
    iter: "infinite",
    stage: (s) => (
      <div style={{ position: "relative", width: 120, height: 130 }}>
        <span className="lp-arrive-token" style={{ ...s, left: "50%", top: 12, translate: "-50% 0", width: 22, height: 22, background: "none" }}>
          <GemaMark size={18} />
        </span>
        <div style={{ position: "absolute", left: "50%", top: 20, bottom: 20, borderLeft: "2px dashed color-mix(in srgb, var(--em) 45%, transparent)" }} />
      </div>
    ),
  },
  {
    name: "lp-rays",
    file: L,
    line: 496,
    note: "God rays slowly shifting in the hero light shaft.",
    dur: 14000,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="lp-rays" style={{ ...s, left: "30%", top: 0, width: "40%", height: "100%", animationDirection: "alternate" }} />,
  },
  {
    name: "lp-mote",
    file: L,
    line: 503,
    note: "Dust drifting up through the shaft (Motes). Each speck has its own speed and start. Phones use a shorter climb (90 px).",
    dur: 12000,
    ease: "linear",
    iter: "infinite",
    keepDelay: true,
    target: ".lp-motes i",
    stage: () => (
      <>
        <Motes count={14} seed={7} className="sbm-motes" />
      </>
    ),
  },
  {
    name: "lp-glint",
    file: L,
    line: 513,
    note: "Four-point stars flashing on the crystals (Glints), one every few seconds.",
    dur: 6500,
    ease: "ease-in-out",
    iter: "infinite",
    keepDelay: true,
    target: ".lp-glints i",
    stage: () => (
      <Glints
        at={[
          [22, 40, 0],
          [50, 62, -2],
          [76, 34, -4],
        ]}
      />
    ),
  },
  {
    name: "lp-progress",
    file: L,
    line: 531,
    note: "The thin line under the landing nav that fills as you scroll. Scroll the box.",
    dur: 0,
    ease: "linear",
    iter: 1,
    scroll: true,
    stage: () => (
      <ScrollBox rows={8}>
        <div className="sbm-sticky" style={{ background: "var(--raised)" }}>
          Nav
          <span className="lp-progress" style={{ animation: "lp-progress linear both", animationTimeline: "scroll(nearest)" }} aria-hidden />
        </div>
      </ScrollBox>
    ),
  },
  {
    name: "lp-beam",
    file: L,
    line: 543,
    note: "The light beam rising from the Gema's plinth breathing.",
    dur: 4800,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="lp-beam" style={{ ...s, width: "60%", height: "90%", bottom: 0 }} />,
  },
  {
    name: "lp-spin",
    file: L,
    line: 551,
    note: "The slow rays turning behind the Gema (one turn a minute).",
    dur: 60000,
    ease: "linear",
    iter: "infinite",
    stage: (s) => <span className="lp-showcase-rays" style={s} />,
  },
  {
    name: "lp-sweep-ring",
    file: L,
    line: 555,
    note: "The light that runs round the frame of the Gema showcase.",
    dur: 7000,
    ease: "linear",
    iter: "infinite",
    target: ".sweep",
    stage: () => (
      <svg className="lp-vitrine" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid meet" aria-hidden>
        <path d="M14 2H146L158 14V86L146 98H14L2 86V14Z" className="outer" />
        <path d="M14 2H146L158 14V86L146 98H14L2 86V14Z" className="sweep" pathLength={100} />
      </svg>
    ),
  },
  {
    name: "lp-crystal-pulse",
    file: L,
    line: 627,
    note: "The glow on the hero crystals pulsing.",
    dur: 5500,
    ease: "ease-in-out",
    iter: "infinite",
    stage: (s) => <span className="lp-crystal-glow" style={mid(s, { ["--x" as string]: "50%", ["--y" as string]: "50%", width: 120 })} />,
  },
];

const meta = {
  title: "Motion/Landing keyframes",
  parameters: { layout: "padded", themed: true },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="The landing page's own animations, from landing.css. Switch the toolbar Theme to see them on paper." />,
};

