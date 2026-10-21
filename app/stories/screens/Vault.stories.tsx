import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Vault from "@/app/(app)/vault/page";
import { demoSnapshot } from "@/lib/chain/fixture";
import type { AccountSnapshot } from "@/lib/chain/read";
import { NATIVE_MARKET, nativePosition } from "../components/wallet/support";
import { withScreen } from "./support/screen";
import { withSigner } from "./support/signer";
import { AuthContext, useAuth } from "@/lib/auth/context";
import type { Decorator } from "@storybook/nextjs-vite";

/** An email sign-in with no linked wallet, so the Account opens in the Simple view (nav shows Vault). */
function EmailOnly({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  return <AuthContext.Provider value={{ ...auth, linked: [] }}>{children}</AuthContext.Provider>;
}
const withEmailOnly: Decorator = (Story) => (
  <EmailOnly>
    <Story />
  </EmailOnly>
);

const meta = {
  title: "Screens/Vault",
  component: Vault,
  decorators: [withEmailOnly, withSigner, withScreen],
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

/** A deposit past its 12 months that is still not ready, and one that is ready to withdraw. */
export const LateDeposit: Story = {
  parameters: {
    data: {
      snapshot: (a: string): AccountSnapshot => {
        const s = demoSnapshot(a);
        const late = nativePosition("debt");
        const native = { ...late.native!, openedAt: Math.floor(Date.now() / 1000) - 86_400 * 400, source: { ...late.native!.source!, math: { ...late.native!.source!.math, issued: 50_000_000_000n, returned: 0n } } };
        return { ...s, market: NATIVE_MARKET, positions: [{ ...late, native }, nativePosition("repaid")], holdings: s.holdings.map((h) => ({ ...h, native: true, eth: null, redeemable: 0n, pending: 0n })) };
      },
    },
  },
};

export const SignedOut: Story = { parameters: { auth: "signed-out" } };
