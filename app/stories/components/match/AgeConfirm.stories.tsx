import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AgeConfirm } from "@/components/match/AgeConfirm";
import "@/components/match/enter.css";

const meta = {
  title: "Components/match/AgeConfirm",
  component: AgeConfirm,
  args: { onConfirm: () => {}, onDecline: () => {} },
  parameters: { layout: "centered", shell: "app" },
  decorators: [(Story) => <div style={{ maxWidth: 560, textAlign: "center" }}><Story /></div>],
} satisfies Meta<typeof AgeConfirm>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Shown once per Account, before its first Match entry. */
export const Ask: Story = {};
export const Saving: Story = { args: { busy: true } };
export const SaveFailed: Story = { args: { error: "That didn’t go through. Try again in a moment." } };
