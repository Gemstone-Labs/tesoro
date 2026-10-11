/* PROTOTYPE ONLY: gallery for the PendingBySource takes. Switch with ?variant=now|A|B|C|D or the pink bar. */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, PendingBySource } from "@/components/ui";

const meta = {
  title: "Prototype/PendingBySource",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type Item = Parameters<typeof PendingBySource>[0]["items"][number];
const THREE: Item[] = [
  { key: "c", chain: "SOL", owner: "Your Position", pending: 4316, accruedShare: 0, id: "7xKp…3fQa" },
  { key: "a", chain: "HYPE", owner: "Bob's Position", pending: 2200, accruedShare: 0.12, id: "0x4F…B238" },
  { key: "b", chain: "ETH", owner: "Carol's Position", pending: 1197, accruedShare: 0.71, id: "0x8B…a3A3" },
];
const ONE: Item[] = [{ key: "c", chain: "SOL", owner: "Your Position", pending: 860, accruedShare: 0.38, id: "7xKp…3fQa" }];
const MANY: Item[] = [
  ...THREE,
  { key: "d", chain: "SOL", owner: "Dana's Position", pending: 940, accruedShare: 0.93, id: "DA9K…P1bS" },
  { key: "e", chain: "ETH", owner: "Eve's Position", pending: 410, accruedShare: 0.44, id: "0xD8…2a28" },
  { key: "f", chain: "SOL", owner: "uoQC…mh7L's Position with a very long name", pending: 75, accruedShare: 0.05, id: "uoQC…mh7L" },
];

function Frame({ title, width, children }: { title: string; width: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, alignContent: "start", width: `min(100%, ${width}px)` }}>
      <span className="mono meta">{title}</span>
      <Card large>{children}</Card>
    </div>
  );
}

const wrap: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 24, padding: 24, alignItems: "start" };

/** Every data shape side by side, at the Wallet's card width and the /design card width. */
export const Gallery: Story = {
  render: () => (
    <div style={wrap}>
      <Frame title="3 Sources · 640" width={640}><PendingBySource items={THREE} /></Frame>
      <Frame title="3 Sources · 460" width={460}><PendingBySource items={THREE} /></Frame>
      <Frame title="6 Sources · 640" width={640}><PendingBySource items={MANY} /></Frame>
      <Frame title="1 Source · 460" width={460}><PendingBySource items={ONE} /></Frame>
      <Frame title="Nothing pending · 460" width={460}><PendingBySource items={[]} /></Frame>
    </div>
  ),
};

export const Phone: Story = {
  globals: { viewport: { value: "phone390" } },
  render: () => (
    <div style={{ display: "grid", gap: 20, padding: 16 }}>
      <Frame title="3 Sources" width={390}><PendingBySource items={THREE} /></Frame>
      <Frame title="6 Sources" width={390}><PendingBySource items={MANY} /></Frame>
    </div>
  ),
};
