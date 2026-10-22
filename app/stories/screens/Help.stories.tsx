import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import Help from "@/app/(app)/help/page";

const meta = {
  title: "Screens/Help",
  component: Help,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/help" } } },
} satisfies Meta<typeof Help>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

const type = (text: string): Story["play"] => async ({ canvasElement }) => {
  await userEvent.type(await within(canvasElement).findByRole("searchbox", { name: "Search Help" }), text);
};

/** Typing "fees" lists the matching answers with the words highlighted. */
export const SearchWithResults: Story = { play: type("fees") };

/** Typing something nobody asked: "0 answers" and the empty note. */
export const SearchNoResults: Story = { play: type("zzzqxv") };
