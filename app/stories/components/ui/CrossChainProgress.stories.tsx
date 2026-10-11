import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, CrossChainProgress } from "@/components/ui";
import { ETH_VAULTS } from "@/lib/chain/eth";
import { opCopy, opSteps } from "@/lib/chain/eth-track";

const meta = {
  title: "Components/ui/CrossChainProgress",
  component: CrossChainProgress,
  args: { stage: 1, chain: "ETH", txHash: "0x7be1…a09c", failed: false },
  argTypes: {
    stage: { control: { type: "range", min: 0, max: 5 } },
    chain: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] },
  },
  decorators: [(Story) => <div style={{ maxWidth: 460 }}><Card large><Story /></Card></div>],
} satisfies Meta<typeof CrossChainProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

const op = (kind: "open" | "redeem", vault: string) => {
  const c = opCopy(kind, vault);
  return { steps: opSteps(kind, vault), label: c.label, finalState: c.finalState, doneText: c.done, pendingText: c.pending, failedText: c.failed };
};

/** Success shows only at the last step. Pending never shows success early. */
export const Started: Story = { args: { stage: 0 } };
export const Verifying: Story = {};
export const Crediting: Story = { args: { stage: 2 } };
export const Done: Story = { args: { stage: 3 } };
export const Failed: Story = { args: { stage: 1, failed: true, chain: "HYPE" } };
/** Opening an ETH Position: five steps, three stations between the tiles. */
export const OpenPosition: Story = { args: { stage: 3, txHash: undefined, ...op("open", ETH_VAULTS[0].address) } };
/** Outbound: from the Account to HyperEVM. */
export const Redeem: Story = { args: { stage: 1, chain: undefined, txHash: undefined, from: "account", to: "HYPE", ...op("redeem", ETH_VAULTS[1].address) } };
