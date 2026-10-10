import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Opening } from "@/app/(app)/wallet/opening/Opening";
import { withScreen, type ScreenData } from "../../screens/support/screen";
import { withSigner } from "../../screens/support/signer";
import { saveOpenOp } from "./support";

const meta = {
  title: "Components/wallet/Opening",
  component: Opening,
  decorators: [withSigner, withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/wallet/opening", query: { op: "open-eth-9" } } } },
} satisfies Meta<typeof Opening>;
export default meta;
type Story = StoryObj<typeof meta>;

const step = (opening: NonNullable<NonNullable<ScreenData["eth"]>["opening"]>): Story => ({
  decorators: [(Story) => (saveOpenOp(), <Story />)],
  parameters: { screen: { eth: { opening } } },
});

/** The cross-chain tracker for an ETH Position that is opening, one story per step. */
export const SentOnHoodi: Story = step("sent");
export const DeliveredToSolana: Story = step("delivered");
export const PositionRecorded: Story = step("recorded");
export const GemasArrived: Story = step("arrived");
export const Failed: Story = step("failed");

/** Nothing is opening in this browser. */
export const NothingOpening: Story = {
  decorators: [(Story) => {
    try {
      localStorage.clear();
    } catch {}
    return <Story />;
  }],
};
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
