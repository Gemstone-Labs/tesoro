import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { NotifySettingsView, type NotifySettingsViewProps } from "@/components/account/NotifySettings";

const noop = () => {};

function Live(args: NotifySettingsViewProps) {
  const [draft, setDraft] = useState(args.draft);
  return (
    <div style={{ maxWidth: 420 }}>
      <NotifySettingsView {...args} draft={draft} onDraft={setDraft} />
    </div>
  );
}

const meta = {
  title: "Components/account/NotifySettings",
  component: NotifySettingsView,
  render: (args) => <Live {...args} />,
  args: { status: { email: null, verified: false, enabled: true }, draft: "", busy: null, error: null, onDraft: noop, onSave: noop, onToggle: noop },
  argTypes: { status: { control: "object" }, onDraft: { control: false }, onSave: { control: false }, onToggle: { control: false } },
} satisfies Meta<typeof NotifySettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Optional "email me when my Match settles" field, nothing set yet. */
export const Empty: Story = {};
export const Loading: Story = { args: { status: null } };
/** Address saved, verify link sent: nothing else is mailed until it is confirmed. */
export const WaitingToConfirm: Story = { args: { status: { email: "ana@example.com", verified: false, enabled: true }, draft: "ana@example.com" } };
export const Confirmed: Story = { args: { status: { email: "ana@example.com", verified: true, enabled: true }, draft: "ana@example.com" } };
/** The off switch: no email at all. */
export const TurnedOff: Story = { args: { status: { email: "ana@example.com", verified: true, enabled: false }, draft: "ana@example.com" } };
export const Sending: Story = { args: { status: { email: null, verified: false, enabled: true }, draft: "ana@example.com", busy: "Sending the link" } };
export const BadAddress: Story = { args: { draft: "ana@", error: "That email address doesn’t look right." } };
