import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ArrowIcon, Button } from "@/components/ui";

const meta = {
  title: "Components/ui/Button",
  component: Button,
  args: { children: "Enter · 1,000 Gemas", variant: "money", size: "md", disabled: false, block: false },
  argTypes: {
    variant: { control: "inline-radio", options: ["money", "neutral"] },
    size: { control: "inline-radio", options: ["sm", "md", "lg"] },
    icon: { control: false },
    onClick: { control: false },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Emerald (`money`) only where Gemas move: Enter, Offer, Redeem, Advance. */
export const Money: Story = {};
export const Neutral: Story = { args: { variant: "neutral", children: "Post Request" } };
export const Small: Story = { args: { size: "sm", children: "Offer" } };
export const Large: Story = { args: { size: "lg", children: "Get Gemas" } };
export const Disabled: Story = { args: { disabled: true, children: "Redeem 0" } };
export const DisabledNeutral: Story = { args: { variant: "neutral", disabled: true, children: "Disabled" } };
export const Block: Story = { args: { block: true, children: "Redeem 1,599" } };
export const WithIcon: Story = { args: { variant: "neutral", icon: <ArrowIcon width={14} height={14} />, children: "Go to Lobby" } };
export const AsLink: Story = { args: { variant: "neutral", href: "/lobby", children: "Lobby" } };
