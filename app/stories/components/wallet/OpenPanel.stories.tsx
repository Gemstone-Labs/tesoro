import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HowGemasWork, NoPositions, OpenFormView, OpenPanel } from "@/app/(app)/wallet/OpenPanel";
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

function Form({ unit = "simSOL", ...rest }: Partial<React.ComponentProps<typeof OpenFormView>>) {
  const [amount, setAmount] = useState("10");
  const [months, setMonths] = useState(3);
  return (
    <OpenFormView
      unit={unit}
      amountText={amount}
      onAmount={setAmount}
      months={months}
      onMonths={setMonths}
      gemas={Number(amount) * months * 25}
      estimate="Today, 12:30"
      buttonLabel="Open Position and take Advance"
      disabled={false}
      onSubmit={() => {}}
      {...rest}
    />
  );
}

export const FormFilled: Story = { render: () => <div style={{ maxWidth: 480 }}><Form amountHint="You have 12.5 simSOL" details={[["Rate", "7.0% a year"], ["Fee", "None"]]} note="Test mode. Simulated yield." /></div> };
export const FormEmpty: Story = { render: () => <div style={{ maxWidth: 480 }}><Form /></div> };
export const FormInvalid: Story = { render: () => <div style={{ maxWidth: 480 }}><Form amountInvalid amountHint="That is more than you have." disabled /></div> };
export const FormWithoutMarket: Story = { render: () => <div style={{ maxWidth: 480 }}><Form inert disabled buttonLabel="Loading…" /></div> };
export const FormWithAlert: Story = { render: () => <div style={{ maxWidth: 480 }}><Form alerts={<p className="status err" role="alert">Something went wrong. Try again.</p>} /></div> };

export const How: Story = { render: () => <div style={{ maxWidth: 520 }}><HowGemasWork /></div> };
export const Empty: Story = { render: () => <div style={{ maxWidth: 720 }}><NoPositions onOpen={() => {}} /></div> };
