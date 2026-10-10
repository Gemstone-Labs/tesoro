import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { DEMO_ME } from "../../support/data";

const meta = {
  title: "Components/account/PlayerName",
  component: PlayerName,
  args: { account: DEMO_ME },
  argTypes: { account: { control: "text" } },
} satisfies Meta<typeof PlayerName>;
export default meta;
type Story = StoryObj<typeof meta>;

/** With no Profile or name, the short Account key. */
export const Default: Story = {};

/** The picture is an animal derived from the key, so the same Player looks the same everywhere. */
export const WithAvatar: Story = {
  render: (args) => (
    <div className="hstack">
      <PlayerAvatar account={args.account} size={48} />
      <PlayerName account={args.account} />
    </div>
  ),
};

export const ManyAvatars: Story = {
  render: () => (
    <div className="hstack" style={{ flexWrap: "wrap" }}>
      {Array.from({ length: 12 }, (_, i) => (
        <PlayerAvatar key={i} account={`demo-account-${i}`} size={56} />
      ))}
    </div>
  ),
};
