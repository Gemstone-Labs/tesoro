import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/app/(app)/backing/backing.css";
import { MyOffer } from "@/components/backing/MyOffer";
import type { ChainOffer } from "@/lib/chain/backing";
import { PublicKey } from "@solana/web3.js";

const offer = (over: Partial<ChainOffer> = {}): ChainOffer => ({
  address: new PublicKey("SysvarRent111111111111111111111111111111111"),
  nonce: 1n,
  backer: "me",
  game: "block-puzzle",
  entry: 500,
  shareBps: 5000,
  status: "consumed",
  expiresAt: 0,
  useBy: 0,
  player: "SysvarC1ock11111111111111111111111111111111",
  request: "r",
  lines: [],
  matchId: "opener-3",
  refundableMatchId: null,
  ticketOpen: false,
  ...over,
});

const meta = {
  title: "Components/backing/MyOffer",
  component: MyOffer,
  args: { requests: new Map(), nowMs: Date.now(), busy: null, onCancel: () => {}, onRelease: () => {}, onRefund: () => {} },
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="bk" style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof MyOffer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nobody joined the Match and its deadline passed: the Backer refunds it. */
export const RefundMatch: Story = { args: { offer: offer({ refundableMatchId: "opener-3" }) } };
export const Refunding: Story = { args: { offer: offer({ refundableMatchId: "opener-3" }), busy: "rf-SysvarRent111111111111111111111111111111111" } };
export const MatchPlaying: Story = { args: { offer: offer() } };
