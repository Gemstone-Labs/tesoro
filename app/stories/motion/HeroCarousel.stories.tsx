import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import "./motion.css";

function Demo() {
  const [n, setN] = useState(0);
  return (
    <div className="sbm">
      <div className="sbm-intro">
        <p>
          The Lobby hero. It moves to the next game every 7 s, the marker fills while it waits, the art settles and the copy rises on each slide. It stops while the pointer or focus is on it and under Reduced motion.
        </p>
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Restart
        </button>
      </div>
      <HeroCarousel key={n} />
    </div>
  );
}

const meta = {
  title: "Motion/Hero carousel",
  component: Demo,
  parameters: { layout: "padded", shell: "app" },
} satisfies Meta<typeof Demo>;
export default meta;

export const AutoAdvance: StoryObj = {};
