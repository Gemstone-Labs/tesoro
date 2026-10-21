import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { OrdersView } from "@/components/admin/OrdersView";
import type { AdminOrder, OrdersReply } from "@/server/admin/orders";

const A = "7zr1j185aLmHqYk3gT9u2WpXcVbN4dEfRs6JqhM1qh7M";
const B = "GXQse6RGq2nYtUwB8cJk5pLvHdZfX3aMrN9sT4eWrMGK";
const C = "G7zDx4Kp9QwLm2VnYbT6uJc8HsRfE3aZoNqXd5iWcTYP";
const now = Math.floor(Date.now() / 1000);

const order = (over: Partial<AdminOrder>): AdminOrder => ({
  address: "ord1",
  nonce: "1",
  account: A,
  owner: A,
  source: "src1",
  position: "pos1",
  kind: "native",
  stakeMint: null,
  asset: "SOL",
  state: "requested",
  requested: 1800,
  sold: 0,
  remaining: 1800,
  ready: 300,
  maxFill: 1500,
  maxFillPayoutShares: "6400000000",
  createdAt: now - 3600,
  expiresAt: now + 6 * 86_400,
  sponsored: true,
  payer: A,
  book: "book1",
  ...over,
});

const reply: OrdersReply = {
  now,
  routes: {
    native: { treasuryShares: "52000000000", owedShares: "9000000000", poolOwed: "4000000000", reserved: "3000000000", spendable: "36000000000" },
    stake: null,
  },
  orders: [
    order({}),
    order({ address: "ord2", account: B, state: "partly-sold", requested: 900, sold: 400, remaining: 500, ready: 0, maxFill: 220 }),
    order({ address: "ord3", account: C, asset: "ETH", kind: "reported", requested: 240, remaining: 240, ready: 0, maxFill: 0 }),
    order({ address: "ord4", account: B, state: "expired", expiresAt: now - 3600, remaining: 120, requested: 120, ready: 0, maxFill: 0 }),
  ],
};

const meta = {
  title: "Screens/Orders",
  component: OrdersView,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/admin/orders" } } },
} satisfies Meta<typeof OrdersView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Admin: open Instant Redeem orders, the Treasury's spendable figure, fill all or part of an order. */
export const Open: Story = { args: { reply } };
export const Filling: Story = { args: { reply, busy: "ord1" } };
export const Filled: Story = { args: { reply, result: { address: "ord1", ok: true, text: "Filled 1500 Gemas. 5Kd3aXpQ…" } } };
export const FillFailed: Story = { args: { reply, result: { address: "ord2", ok: false, text: "This order is gone: it was filled, cancelled or closed." } } };
export const NoOrders: Story = { args: { reply: { ...reply, orders: [] } } };
export const Loading: Story = { args: { reply: null } };
export const SignedOut: Story = { args: { reply: null, signedOut: true } };
export const NotAllowed: Story = { args: { reply: null, error: "This wallet is not on the admin list." } };
