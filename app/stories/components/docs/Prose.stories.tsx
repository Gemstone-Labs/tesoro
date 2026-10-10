import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Addr, Callout, Code, DataTable, H2, H3, Sim, Steps, explorer } from "@/components/docs/prose";
import { inProse } from "./support";

const meta = {
  title: "Components/docs/Prose",
  parameters: { themed: true, layout: "fullscreen" },
  decorators: [inProse],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Headings carry an anchor link on hover. */
export const Headings: Story = {
  render: () => (
    <>
      <H2 id="a-section">A section heading</H2>
      <p>Body text sits under it, in the same measure as the real pages.</p>
      <H3 id="a-subsection">A subsection heading</H3>
      <p>Smaller, for the parts of a section.</p>
    </>
  ),
};

export const Callouts: Story = {
  args: {},
  argTypes: {},
  render: () => (
    <div className="stack">
      <Callout title="A note">Notes explain something that is easy to miss.</Callout>
      <Callout kind="sim" title="Simulated">Yield here is simulated: 1 month = 10 min.</Callout>
      <Callout kind="warn" title="Test mode">Nothing here has value.</Callout>
      <Callout>A callout without a title.</Callout>
    </div>
  ),
};

export const SimLabel: Story = {
  render: () => <p>Yield is <Sim /> in test mode, and <Sim>test only</Sim> here too.</p>,
};

export const Table: Story = {
  render: () => (
    <DataTable
      caption="Fees"
      head={["Fee", "Rate", "Paid by"]}
      rows={[
        ["Platform", "2%", "The Pot"],
        ["Studio", "3%", "The Pot"],
        ["Leaderboard", "1%", "The Pot"],
      ]}
    />
  ),
};

export const CodeBlock: Story = {
  render: () => <Code label="Run it">{"pnpm install\npnpm dev\n"}</Code>,
};

export const Addresses: Story = {
  render: () => (
    <div className="stack">
      <Addr label="tesoro_core" value="AR9cLmGq3FvR8kZqf2eE1WcXKz9sT4n6pBvDhUjY5aQx" href={explorer("AR9c")} />
      <Addr label="Vault" value="0x8B09a3A3d51c6F9a2B08E7a3d51c6F9a2B08a3A3" note="Hoodi test network" />
    </div>
  ),
};

export const NumberedSteps: Story = {
  render: () => (
    <Steps
      items={[
        { title: "Open a Position", body: "Lock simulated stake in your Wallet." },
        { title: "Take an Advance", body: "Get Gemas against the yield." },
        { title: "Play", body: "Enter a Match with your Gemas." },
      ]}
    />
  ),
};
