import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EntryPlan } from "@/components/match/EntryPlan";
import type { StagedEntry as Staged } from "@/lib/chain/ticket";

const staged = (done: bigint, target: bigint): Staged => ({ staged: done, target, progress: Number((done * 1000n) / target) / 1000, complete: done >= target, cancelling: false, expired: false, stepsLeft: done >= target ? 0 : 2, expiresIn: 3000 });

const meta = {
  title: "Components/match/EntryPlan",
  component: EntryPlan,
  decorators: [
    (Story) => (
      <div className="enter" style={{ maxWidth: 560, margin: "32px auto" }}>
        <div className="enter-foot">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof EntryPlan>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An entry of 480 Gemas drawn from 40 small lines: prepared in steps, 190 of 480 ready so far. */
export const StagedEntry: Story = { args: { staged: staged(190n, 480n) } };
export const StagedAlmostDone: Story = { args: { staged: staged(470n, 480n) } };
export const StagedComplete: Story = { args: { staged: staged(480n, 480n) } };
