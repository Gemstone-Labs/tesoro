import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { GuideOverlay, GuideProvider, useGuideTip, type PoseName } from "@/components/guide/Guide";
import "./motion.css";

function Tip({ pose, title, text }: { pose: PoseName; title: string; text: string }) {
  useGuideTip({ id: "story-tip", pose, title, text });
  return null;
}

function Demo({ pose, title, text }: { pose: PoseName; title: string; text: string }) {
  const [n, setN] = useState(0);
  const replay = () => {
    try {
      localStorage.removeItem("tesoro-guide-dismissed");
    } catch {}
    setN((v) => v + 1);
  };
  return (
    <>
      <div className="sbm-panel" style={{ margin: 24 }}>
        <h2>A page under the Guide</h2>
        <p className="meta">The page dims, the character rises from the bottom right, then the bubble pops in. Escape or Got it ends it.</p>
      </div>
      <div className="sbm-note" style={{ zIndex: 80 }}>
        <button type="button" className="sbm-btn primary" onClick={replay}>
          Replay
        </button>
        <span>Needs the toolbar Guide switch (set on for this story).</span>
      </div>
      <GuideProvider key={n}>
        <Tip pose={pose} title={title} text={text} />
        <GuideOverlay />
      </GuideProvider>
    </>
  );
}

const meta = {
  title: "Motion/Guide entrance",
  component: Demo,
  parameters: { layout: "fullscreen", guide: "on" },
  args: { pose: "himWelcome", title: "Welcome to Tesoro", text: "Pick a game, set your entry and play. Your Gemas stay safe: only the yield is at stake." },
  argTypes: { pose: { control: "select", options: ["himWelcome", "himExplain", "herBacking", "herWaitingCrosschain"] } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Welcome: Story = {};

export const Explain: Story = { args: { pose: "himExplain", title: "How entries work", text: "Your entry is held until the Match ends. The winner takes the pot." } };

export const Backing: Story = { args: { pose: "herBacking", title: "Back a Player", text: "Fund a Player's entry and share what they win." } };
