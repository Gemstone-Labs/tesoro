import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { CountUp } from "@/components/ui";
import "./motion.css";

function Demo({ value, from, duration }: { value: number; from: number; duration: number }) {
  const [n, setN] = useState(0);
  return (
    <div className="sbm-panel">
      <div className="sbm-big" key={`${n}-${from}-${duration}`}>
        <CountUp value={value} from={from} duration={duration} />
      </div>
      <div className="sbm-row">
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Replay
        </button>
        <span className="meta">Rolls from {from.toLocaleString("en-US")} to {value.toLocaleString("en-US")} (ease-out, cubic). Change the value in Controls to roll from where it is now.</span>
      </div>
    </div>
  );
}

const meta = {
  title: "Motion/Count up",
  component: Demo,
  parameters: { layout: "padded" },
  args: { value: 1240, from: 0, duration: 800 },
  argTypes: {
    value: { control: { type: "number" } },
    from: { control: { type: "number" } },
    duration: { control: { type: "range", min: 100, max: 4000, step: 50 } },
  },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A balance rolling to its new value: the Wallet and the top bar. */
export const Balance: Story = {};

/** A won amount counting up on the result. */
export const WonAmount: Story = { args: { value: 900, from: 0, duration: 800 } };

export const Slow: Story = { args: { value: 25000, from: 1000, duration: 3000 } };
