import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Glints, Motes } from "@/components/landing/Fx";
import "./motion.css";

interface Props {
  motes: number;
  seed: number;
  glints: boolean;
}

function Demo({ motes, seed, glints }: Props) {
  const [n, setN] = useState(0);
  return (
    <div className="sbm-panel">
      <div className="sbm-row">
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Replay
        </button>
        <span className="meta">Dust and glints over the hero art. Motes are placed from the seed, so every load looks the same.</span>
      </div>
      <div className="sbm-canvas" key={`${n}-${motes}-${seed}-${glints}`} style={{ background: "#090d0f" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/art/landing/heroBack-1280.webp" alt="" />
        <Motes count={motes} seed={seed} className="lp-shaft-motes" />
        {glints && (
          <Glints
            at={[
              [88, 29, 0],
              [52, 46, -2.2],
              [70, 62, -4.4],
            ]}
          />
        )}
      </div>
    </div>
  );
}

const meta = {
  title: "Motion/Landing effects",
  component: Demo,
  parameters: { layout: "padded", themed: true },
  args: { motes: 18, seed: 7, glints: true },
  argTypes: { motes: { control: { type: "range", min: 0, max: 60, step: 1 } }, seed: { control: { type: "number" } } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Motes drifting up the light shaft and glints flashing on the crystals (Fx.tsx). */
export const MotesAndGlints: Story = {};
