import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Vault from "@/app/(app)/vault/page";
import { demoSnapshot } from "@/lib/chain/fixture";
import type { AccountSnapshot } from "@/lib/chain/read";
import { NATIVE_MARKET, nativePosition } from "../components/wallet/support";
import { withScreen } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Vault",
  component: Vault,
  decorators: [withSigner, withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/vault" } } },
} satisfies Meta<typeof Vault>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A new Player: nothing yet. */
export const NewPlayer: Story = {
  parameters: { data: { snapshot: (a: string): AccountSnapshot => ({ ...demoSnapshot(a), positions: [], holdings: [], ownTotal: 0n, wonTotal: 0n, market: NATIVE_MARKET }) } },
};

/** One deposit, still on its way back, and some winnings. */
export const WithDeposits: Story = {
  parameters: {
    data: {
      snapshot: (a: string): AccountSnapshot => {
        const s = demoSnapshot(a);
        return {
          ...s,
          market: NATIVE_MARKET,
          positions: [nativePosition("debt"), nativePosition("repaid")],
          holdings: s.holdings.map((h) => ({ ...h, native: true, eth: null, redeemable: h.isOwn ? 0n : 300n, pending: h.isOwn ? 0n : 500n })),
        };
      },
    },
  },
};

export const SignedOut: Story = { parameters: { auth: "signed-out" } };
