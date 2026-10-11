// PROTOTYPE ONLY (branch proto/rows-11-10-2026): the Row primitive in every way it is used, on one
// page; the pink bar (or ←/→) switches all of them between the variants in Row.prototype.tsx.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Image from "next/image";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { Row, Thumb } from "@/components/ui";
import { ROW_VARIANTS, RowList } from "@/components/ui/Row.prototype";
import { art } from "@/lib/art";

const noop = () => undefined;
const avatar = (i: number) => (
  <span className="cut cut-chip thumb" style={{ position: "relative", overflow: "hidden", background: "#1a2128" }}>
    <Image src={art.avatars[i]} alt="" fill sizes="52px" style={{ objectFit: "cover" }} />
  </span>
);

function Gallery() {
  return (
    <div style={{ display: "grid", gap: 28, maxWidth: 980 }}>
      <PrototypeSwitcher variants={ROW_VARIANTS} />
      <section style={{ display: "grid", gap: 12 }}>
        <h3 className="h-section" style={{ fontSize: 28 }}>Finished Matches</h3>
        <RowList>
          <Row title="Block Puzzle" meta="vs Otter · 171 – 140" when="2 min ago" game="block-puzzle" delta={900} cta="Open" href="#a" />
          <Row title="Hold'em" meta="vs Lynx · Entry 500" when="1 h ago" game="holdem" delta={-500} cta="Open" href="#b" />
          <Row title="Trading Duel" meta="vs Heron · SOL · +4.2% – +4.2%" when="3 h ago" game="trading-duel" delta={0} cta="Open" href="#c" />
          <Row title="Block Puzzle" meta="vs Fox · 96 – 210" when="Yesterday" game="block-puzzle" delta={-1000} cta="Open" href="#d" />
        </RowList>
      </section>
      <section style={{ display: "grid", gap: 12 }}>
        <h3 className="h-section" style={{ fontSize: 28 }}>Games and Offers</h3>
        <RowList>
          <Row title="Heads-up Hold'em" meta="Live · 2 in Queue" game="holdem" cta="Play" href="#e" />
          <Row thumb={avatar(3)} title="Dana asks for 1,000" meta="Block Puzzle · 38 Matches · 61% won" cta="Offer" ctaTone="money" onClick={noop} />
          <Row thumb={<Thumb variant="poker">A♠K</Thumb>} title="Thumb, no art" meta="Live · 0 in Queue" cta="Play" href="#f" />
          <Row title="Static row" meta="No action" />
        </RowList>
      </section>
      <section style={{ display: "grid", gap: 12, maxWidth: 390 }}>
        <h3 className="h-section" style={{ fontSize: 28 }}>Phone width (390)</h3>
        <RowList>
          <Row title="Block Puzzle" meta="vs Otter · 171 – 140" when="2 min ago" game="block-puzzle" delta={900} cta="Open" href="#g" />
          <Row title="Hold'em" meta="vs Lynx · Entry 500" when="1 h ago" game="holdem" delta={-500} cta="Open" href="#h" />
          <Row thumb={avatar(3)} title="Dana asks for 1,000" meta="Block Puzzle · 38 Matches" cta="Offer" ctaTone="money" onClick={noop} />
        </RowList>
      </section>
    </div>
  );
}

const meta = { title: "Prototype/Rows", component: Gallery, parameters: { layout: "padded" } } satisfies Meta<typeof Gallery>;
export default meta;
/** Hover the rows. Pink bar or ←/→ switches every Row on the page. */
export const AllUses: StoryObj<typeof meta> = {};
