import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HowGemasWork, NoPositions, OpenFormView, OpenPanel } from "@/app/(app)/wallet/OpenPanel";
import { GemasLabel } from "@/app/(app)/wallet/AdvanceQuote";
import type { Chain } from "@/lib/mock/types";

const meta = {
  title: "Components/wallet/OpenPanel",
  component: OpenPanel,
  args: { tab: "SOL", onTab: () => {}, children: <p className="meta">The form for the chosen chain goes here.</p> },
  argTypes: { tab: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] }, onTab: { control: false }, children: { control: false } },
  decorators: [(Story) => <div style={{ maxWidth: 520 }}><Story /></div>],
  render: function Render(args) {
    const [tab, setTab] = useState<Chain>(args.tab);
    return <OpenPanel {...args} tab={tab} onTab={setTab} />;
  },
} satisfies Meta<typeof OpenPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Chain tabs over the active chain's form. */
export const Tabs: Story = {};

export const WithForm: Story = {
  render: function Render(args) {
    const [tab, setTab] = useState<Chain>(args.tab);
    return (
      <OpenPanel {...args} tab={tab} onTab={setTab}>
        <Form />
      </OpenPanel>
    );
  },
};

function Form(props: Partial<React.ComponentProps<typeof OpenFormView>>) {
  const [amount, setAmount] = useState("10");
  const [months, setMonths] = useState(3);
  const gemas = Number(amount) * months * 25;
  return (
    <OpenFormView
      chain="SOL"
      apy="7% APY"
      amountText={amount}
      onAmount={setAmount}
      max={12.5}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${((Number(amount) * 0.07 * months) / 12).toFixed(4)} SOL`}
      estimate="Today, 12:30"
      buttonLabel={<GemasLabel action="Open a Position" gemas={gemas} />}
      disabled={false}
      onSubmit={() => {}}
      {...props}
    />
  );
}

const box = (node: React.ReactNode) => <div style={{ maxWidth: 480 }}>{node}</div>;

export const FormFilled: Story = {
  render: () => box(<Form balance={<>You have <b>12.5</b> simSOL</>} details={[["Rate", "7.0% a year"], ["Fee", "None"]]} note={<span className="sim">Simulated yield · 1 month = 10 min</span>} />),
};
export const FormEmpty: Story = { render: () => box(<Form amountText="" onAmount={() => {}} gemas={0} buttonLabel="Open a Position" disabled />) };
export const FormInvalid: Story = {
  render: () => box(<Form amountInvalid balance="You have 12.5 simSOL" alerts={<p className="status err" role="alert">That is more simSOL than you have.</p>} disabled />),
};
export const FormWithoutMarket: Story = { render: () => box(<Form inert apy={undefined} max={undefined} gemas={null} estimate="—" disabled buttonLabel="Open a Position" />) };
export const FormWithAlert: Story = { render: () => box(<Form alerts={<p className="status err" role="alert">Something went wrong. Try again.</p>} />) };
/** The HYPE tab: the Gemas arrive once the Position reaches Tesoro. */
export const FormHype: Story = { render: () => box(<Form chain="HYPE" yieldText="0.0350 HYPE" arrival="Position opens, Gemas in 2 to 5 min" buttonLabel={<GemasLabel action="Open a HYPE Position" gemas={750} />} />) };

export const How: Story = { render: () => <div style={{ maxWidth: 520 }}><HowGemasWork /></div> };
export const Empty: Story = { render: () => <div style={{ maxWidth: 720 }}><NoPositions onOpen={() => {}} /></div> };
