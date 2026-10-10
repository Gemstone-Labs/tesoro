import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Backing from "@/app/(app)/backing/page";
import { demoKey, withScreen } from "./support/screen";

const meta = {
  title: "Screens/Backing",
  component: Backing,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/backing" } } },
} satisfies Meta<typeof Backing>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Players asking to be backed, with their record. */
export const Board: Story = {};

export const BoardSignedOut: Story = { parameters: { auth: "signed-out" } };

export const EmptyBoard: Story = {
  parameters: { data: { board: { requests: [], offers: [], fetchedAt: Date.now() } } },
};

/** `/backing#<request>` opens the Offer drawer for that Request. */
export const OfferDrawer: Story = { parameters: { screen: { hash: demoKey(601) } } };

export const Loading: Story = { parameters: { screen: { board: "loading" } } };

export const LoadFailed: Story = { parameters: { screen: { board: "error" } } };
