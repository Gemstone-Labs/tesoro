import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { AccountMenu } from "@/components/shell/AccountMenu";

const meta = {
  title: "Components/shell/AccountMenu",
  component: AccountMenu,
  parameters: { auth: "signed-in" },
  decorators: [(Story) => <div style={{ minHeight: 320, display: "flex", justifyContent: "flex-end" }}><Story /></div>],
} satisfies Meta<typeof AccountMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Account menu" }));
    await expect(within(canvasElement).getByRole("menu")).toBeInTheDocument();
  },
};
