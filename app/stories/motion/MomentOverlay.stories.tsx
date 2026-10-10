import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { MomentOverlay } from "@/components/match/MomentOverlay";
import "@/components/match/match.css";
import "./motion.css";

type Props = { title: string; amount: number; bust: "himWin" | "duoWin" };

function Demo({ title, amount, bust }: Props) {
  const [n, setN] = useState(0);
  const [stamp] = useState(() => Date.now());
  return (
    <>
      <div className="sbm-note">
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Replay
        </button>
        <span>Shows ~3 s, or click / Esc / Enter to close.</span>
      </div>
      <MomentOverlay key={n} bust={bust} title={title} amount={amount} momentKey={`story-${n}-${stamp}`} />
    </>
  );
}

const meta = {
  title: "Motion/Moment overlay",
  component: Demo,
  parameters: { layout: "fullscreen" },
  args: { title: "You won", amount: 900, bust: "himWin" },
  argTypes: { bust: { control: "inline-radio", options: ["himWin", "duoWin"] } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The short celebration after a won Match: the bust pops up in a burst of light. */
export const Win: Story = {};

/** The same moment for a Backer whose Player won. */
export const BackedWin: Story = { args: { title: "Backed win", amount: 450, bust: "duoWin" } };
