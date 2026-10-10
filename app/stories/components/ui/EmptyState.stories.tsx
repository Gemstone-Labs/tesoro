import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EmptyState } from "@/components/ui";

const meta = {
  title: "Components/ui/EmptyState",
  component: EmptyState,
  args: { title: "Nothing here yet", body: "We could not find that page. Head back to the Lobby to pick a Game.", bust: "himWaiting" },
  argTypes: {
    bust: { control: "select", options: ["himWelcome", "himExplain", "himWin", "himLose", "himWaiting", "herBacking", "herEmpty", "herWaitingCrosschain"] },
    action: { control: false },
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NoAction: Story = { args: { action: null } };
export const Backer: Story = { args: { bust: "herEmpty", title: "No Requests", body: "Nobody is asking to be backed right now." } };
