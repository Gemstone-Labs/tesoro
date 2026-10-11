/* PROTOTYPE ONLY: gallery for the CrossChainProgress takes. Switch with ?variant=now|A|B|C|D or the pink bar. */
import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, ChainChip, CrossChainProgress } from "@/components/ui";
import { opCopy, opSteps } from "@/lib/chain/eth-track";
import { ETH_VAULTS } from "@/lib/chain/eth";

const meta = {
  title: "Prototype/CrossChainProgress",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const ETH = ETH_VAULTS[0].address;
const HYPE_VAULT = ETH_VAULTS[1].address;

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
      <span className="mono meta">{title}</span>
      <Card large>{children}</Card>
    </div>
  );
}

function Op({ kind, vault, stage, failed }: { kind: "open" | "redeem" | "unlock" | "yield"; vault: string; stage: number; failed?: boolean }) {
  const c = opCopy(kind, vault);
  return (
    <CrossChainProgress
      stage={stage}
      failed={failed}
      steps={opSteps(kind, vault)}
      label={c.label}
      finalState={c.finalState}
      doneText={c.done}
      pendingText={c.pending}
      failedText={c.failed}
    />
  );
}

const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: 24, padding: 24 };

/** Every state the Wallet can show: the Advance (3 steps) through its stages, then the ETH/HYPE operations. */
export const Gallery: Story = {
  render: () => (
    <div style={grid}>
      <Frame title="Advance · started (0/3)"><CrossChainProgress stage={0} chain="ETH" txHash="0x7be1…a09c" /></Frame>
      <Frame title="Advance · verifying (1/3)"><CrossChainProgress stage={1} chain="ETH" txHash="0x7be1…a09c" /></Frame>
      <Frame title="Advance · crediting (2/3)"><CrossChainProgress stage={2} chain="ETH" txHash="0x7be1…a09c" /></Frame>
      <Frame title="Advance · done (3/3)"><CrossChainProgress stage={3} chain="ETH" txHash="0x7be1…a09c" /></Frame>
      <Frame title="Advance · failed at 2 (HYPE)"><CrossChainProgress stage={1} failed chain="HYPE" /></Frame>
      <Frame title="Open ETH Position · 5 steps, at 3"><Op kind="open" vault={ETH} stage={3} /></Frame>
      <Frame title="Redeem → HyperEVM · at 2"><Op kind="redeem" vault={HYPE_VAULT} stage={1} /></Frame>
      <Frame title="Unlock → Ethereum · done"><Op kind="unlock" vault={ETH} stage={3} /></Frame>
      <Frame title="Report yield · at 1"><Op kind="yield" vault={ETH} stage={0} /></Frame>
    </div>
  ),
};

/** The Wallet operation card around it, auto-advancing one step every 2.5 s, to judge the motion. */
export const Live: Story = {
  render: function Live() {
    const steps = opSteps("open", ETH).length;
    const [stage, setStage] = useState(0);
    useEffect(() => {
      const t = setTimeout(() => setStage((s) => (s >= steps + 1 ? 0 : s + 1)), stage >= steps ? 3500 : 2500);
      return () => clearTimeout(t);
    }, [stage, steps]);
    const adv = Math.min(stage, 3);
    return (
      <div style={grid}>
        <Frame title="Wallet · Opening an ETH Position (5 steps)">
          <div className="stack">
            <span className="hstack"><ChainChip chain="ETH" /><strong>Opening an ETH Position</strong></span>
            <Op kind="open" vault={ETH} stage={Math.min(stage, steps)} />
          </div>
        </Frame>
        <Frame title="Advance sheet (3 steps)">
          <CrossChainProgress stage={adv} chain="HYPE" txHash="0x7be1…a09c" />
        </Frame>
      </div>
    );
  },
};

/** Phone width. */
export const Phone: Story = {
  ...Gallery,
  globals: { viewport: { value: "mobile1" } },
  render: () => (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 390 }}>
      <Frame title="Advance · verifying"><CrossChainProgress stage={1} chain="ETH" txHash="0x7be1…a09c" /></Frame>
      <Frame title="Open · 5 steps, at 3"><Op kind="open" vault={ETH} stage={3} /></Frame>
      <Frame title="Advance · done"><CrossChainProgress stage={3} chain="ETH" /></Frame>
    </div>
  ),
};
