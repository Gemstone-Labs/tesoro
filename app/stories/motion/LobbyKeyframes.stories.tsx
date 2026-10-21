import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { art } from "@/lib/art";
import { GemaMark } from "@/components/ui";
import { Lab, stagger, type Spec } from "./lab";

const F = "src/components/lobby/lobby.css";

const frame = { position: "relative", width: 260, height: 130, overflow: "hidden" } as const;

const specs: Spec[] = [
  {
    name: "hero-fill",
    file: F,
    line: 41,
    note: "The slide marker filling while the hero auto-advances (7 s per slide).",
    dur: 7000,
    ease: "linear",
    iter: 1,
    fill: "both",
    target: ".dots button i",
    stage: () => (
      <div className="dots">
        <button type="button" className="on" aria-label="Current slide">
          <i />
        </button>
        <button type="button" aria-label="Next slide" />
        <button type="button" aria-label="Last slide" />
      </div>
    ),
  },
  {
    name: "hero-settle",
    file: F,
    line: 149,
    note: "The hero art easing in from slightly zoomed, over 9 s.",
    dur: 9000,
    ease: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => (
      <div style={frame}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={art.blockPuzzleHero} alt="" style={{ ...s, width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    ),
  },
  {
    name: "hero-rise",
    file: F,
    line: 155,
    note: "The hero copy rising in order: title, line, entry, button (70 ms apart).",
    dur: 700,
    ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    iter: 1,
    fill: "both",
    stage: (s) => (
      <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
        <b style={{ ...s, fontSize: 26 }}>Block Burst</b>
        <span style={{ ...stagger(s, 70), fontSize: 13, color: "var(--fg-2)" }}>Same pieces · 90 seconds</span>
        <span style={{ ...stagger(s, 140), fontSize: 13 }}>Entry 1,000</span>
        <span className="cut cut-btn btn money" style={stagger(s, 210)}>Play now</span>
      </div>
    ),
  },
  {
    name: "twinkle",
    file: F,
    line: 174,
    note: "The sparkles over the hero art. Each one has its own start, so the delay is left as built.",
    dur: 3800,
    ease: "ease-in-out",
    iter: "infinite",
    keepDelay: true,
    target: ".sparkles i",
    stage: () => (
      <div style={{ ...frame, background: `center / cover url(${art.blockPuzzleHero})` }}>
        <span className="sparkles">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      </div>
    ),
  },
  {
    name: "live-pulse",
    file: F,
    line: 180,
    note: "The red dot beside Live and on playing tiles.",
    dur: 1800,
    ease: "ease-out",
    iter: "infinite",
    stage: (s) => <i className="live-dot" style={s} aria-hidden="true" />,
  },
  {
    name: "lw-scroll",
    file: F,
    line: 184,
    note: "The Live wins strip drifting past. It pauses on hover. The real length is 6 s per win, at least 36 s.",
    dur: 36000,
    ease: "linear",
    iter: "infinite",
    target: ".lw-track",
    stage: () => (
      <div className="cut live-wins" style={{ width: "100%" }}>
        <span className="live-tag">
          <i className="live-dot" aria-hidden="true" /> Live
        </span>
        <div className="lw-viewport">
          <ul className="lw-track" style={{ ["--dur" as string]: "36s" }}>
            {Array.from({ length: 2 }, (_, k) =>
              ["Mira", "Joao", "Sam", "Lea", "Ravi", "Ana"].map((n, i) => (
                <li key={`${k}${n}`} aria-hidden={k === 1 || undefined}>
                  <a href="#win" tabIndex={-1}>
                    <b>{n}</b> won <strong><GemaMark size={14} /> {(i + 2) * 450}</strong>
                  </a>
                </li>
              )),
            )}
          </ul>
        </div>
      </div>
    ),
  },
];

const meta = {
  title: "Motion/Lobby keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="The Lobby hero, the Live strip and the play tiles. The hero as a whole is in Motion / Hero carousel." />,
};
