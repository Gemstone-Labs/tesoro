import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NativeFaucet, NativeOpenForm } from "@/app/(app)/wallet/NativePositions";

const meta = {
  title: "Components/wallet/NativeOpenForm",
  component: NativeOpenForm,
  args: { market: null, loading: false },
  argTypes: { market: { control: false }, onDone: { control: false } },
  decorators: [(Story) => <div style={{ maxWidth: 480 }}><Story /></div>],
} satisfies Meta<typeof NativeOpenForm>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The SOL tab's form. It needs the chain's price and balance, which Storybook does not have, so it shows its empty shape. */
export const NoMarketYet: Story = {};
export const Loading: Story = { args: { loading: true } };

/** The test simSOL button and balance. */
export const Faucet: Story = {
  render: () => <NativeFaucet market={null} loading={false} />,
};
