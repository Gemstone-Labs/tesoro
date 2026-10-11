/* PROTOTYPE ONLY: gallery for the PositionTile takes. Switch with ?variant=now|A|B|C|D or the pink bar. */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PositionTile, emptyRows, linearSeries } from "@/app/(app)/wallet/PositionTile";
import { PT_VARIANTS } from "@/app/(app)/wallet/PositionTile.prototype";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { Button } from "@/components/ui";

const meta = {
  title: "Prototype/PositionTile",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.now();
const gemas = (n: number) => Math.round(n).toLocaleString("en-US");

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
      <span className="mono meta">{title}</span>
      {children}
    </div>
  );
}

function Tiles() {
  return (
    <>
      <Frame title="SOL · repaying (Wallet, native)">
        <PositionTile
          chain="SOL" label="SOL Position" status="active" chartTitle="Debt (Gemas)" fmt={gemas}
          rows={{ principal: "40.000 SOL", debt: "1,377 Gemas · 0.550 SOL", apy: "7.0%", unlock: "Oct 11, 17:02 (in 8 min)" }}
          series={linearSeries(1377, NOW, NOW + 8 * 60_000)}
        >
          <Button size="sm" block>Refresh yield</Button>
          <div className="wl-actions-row"><Button variant="money" size="sm">Redeem</Button><Button size="sm" disabled>Unlock</Button></div>
          <p className="note wl-tile-note">Accrued yield 0.04512 SOL (simulated).</p>
          <p className="note wl-tile-note">Unlock returns the Principal once Debt is zero. Only this Position&apos;s own yield repays it.</p>
        </PositionTile>
      </Frame>
      <Frame title="ETH · repaying, long figures (cross-chain)">
        <PositionTile
          chain="ETH" label="ETH Position" status="active" chartTitle="Debt (Gemas)" fmt={gemas}
          rows={{ principal: "2.0000 ETH", debt: "4,928 Gemas · 0.0155 ETH", apy: "3.0%", unlock: "Oct 11, 17:14 (in ~12 min)" }}
          series={linearSeries(4928, NOW, NOW + 12 * 60_000)}
        >
          <Button size="sm" block>Report yield</Button>
          <div className="wl-actions-row"><Button variant="money" size="sm" disabled>Redeem</Button><Button size="sm" disabled>Unlock</Button></div>
          <p className="note wl-tile-note">Accrued on Ethereum 0.00093 ETH (simulated).</p>
          <p className="note wl-tile-note">~412 Gemas of Debt are already repaid by yield accrued on Ethereum. Report yield to apply it (a small cross-chain fee).</p>
        </PositionTile>
      </Frame>
      <Frame title="HYPE · Debt zero, ready to unlock">
        <PositionTile
          chain="HYPE" label="HYPE Position" status="active" chartTitle="Debt (Gemas)" fmt={gemas}
          rows={{ principal: "1.5000 HYPE", debt: "0", apy: "5.0%", unlock: "Debt is zero" }}
          series={null}
        >
          <Button size="sm" block>Report yield</Button>
          <div className="wl-actions-row"><Button variant="money" size="sm">Redeem</Button><Button size="sm">Unlock</Button></div>
        </PositionTile>
      </Frame>
      <Frame title="SOL · no Advance taken">
        <PositionTile
          chain="SOL" label="SOL Position" status="active" chartTitle="Debt (SOL)"
          rows={{ principal: "12 SOL", debt: "0 SOL", apy: "7.0%", unlock: "No open Advance" }}
          series={null} fmt={gemas}
        >
          <Button variant="money" size="sm" block>Take an Advance</Button>
        </PositionTile>
      </Frame>
      <Frame title="SOL · unlocked">
        <PositionTile
          chain="SOL" label="SOL Position" status="unlocked" chartTitle="Debt (Gemas)" fmt={gemas}
          rows={{ principal: "40.000 SOL", debt: "0", apy: "7.0%", unlock: "Unlocked" }}
          series={null}
        >
          <Button size="sm" block>Collect leftover yield · 0.0021 simSOL</Button>
          <p className="note wl-tile-note">Accrued yield 0.31210 SOL (simulated).</p>
        </PositionTile>
      </Frame>
      <Frame title="No Position · coming soon">
        <div style={{ display: "grid", gap: 16 }}>
          <PositionTile chain="ETH" label="ETH Position" status="none" chartTitle="Debt" rows={emptyRows} series={null}>
            <Button variant="money" size="sm" block>Open a Position</Button>
          </PositionTile>
          <PositionTile chain="HYPE" label="HYPE Position" status="soon" chartTitle="Debt" rows={emptyRows} series={null} />
        </div>
      </Frame>
    </>
  );
}

/** Every state at the Wallet's column width (535px at 1440). */
export const Gallery: Story = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 520px), 1fr))", gap: 28, padding: 28, maxWidth: 1700 }}>
      <Tiles />
      <PrototypeSwitcher variants={PT_VARIANTS} />
    </div>
  ),
};

/** Phone width. */
export const Phone: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <div style={{ display: "grid", gap: 24, padding: 16, maxWidth: 390 }}>
      <Tiles />
      <PrototypeSwitcher variants={PT_VARIANTS} />
    </div>
  ),
};
