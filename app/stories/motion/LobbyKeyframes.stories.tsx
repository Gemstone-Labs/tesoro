import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GemaMark } from "@/components/ui";
import { Lab, type Spec } from "./lab";

const F = "src/components/lobby/lobby.css";

const specs: Spec[] = [
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
  title: "Motion/Play keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="The Live wins strip on Play." />,
};
