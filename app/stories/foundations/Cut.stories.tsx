import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Kit, Quote, Section } from "../kit/Kit";
import { GemaMark } from "@/components/ui/gema";

const meta = { title: "Foundations/The cut", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const CUTS = [
  ["cut-frame", "Heroes, sheets", "--cut-frame"],
  ["cut-card", "Cards, nav items, tiles", "--cut-card"],
  ["cut-btn", "Buttons, avatars", "--cut-btn"],
  ["cut-chip", "Chips, entry buttons", "--cut-chip"],
] as const;

/** One corner size per component class. The 1px outline follows the chamfer. */
export const Shapes: Story = {
  render: () => (
    <Kit>
      <Quote>Chamfered (octagonal) corners on every card, chip, button, search box, balance pill, arrow button, avatar and tile. Never rounded rectangles or pills. (DESIGN.md, The cut)</Quote>
      <div className="kit-grid" style={{ ["--min" as string]: "200px" }}>
        {CUTS.map(([cls, use, token]) => (
          <div key={cls} className={`cut ${cls} kit-cut-demo`} style={{ minHeight: 120 }}>
            <span><b style={{ color: "var(--fg)" }}>.cut .{cls}</b><br />{use}<br /><code>{token}</code></span>
          </div>
        ))}
      </div>
    </Kit>
  ),
};

/** The outline is a vertical gradient: bright on the top edge, fading down. Light from above. */
export const Edges: Story = {
  render: () => (
    <Kit>
      <div className="kit-grid" style={{ ["--min" as string]: "200px" }}>
        {[
          ["--edge-1", "Cards"],
          ["--edge-2", "Controls"],
          ["--edge-em", "Balance pill, money panels"],
        ].map(([edge, use]) => (
          <div key={edge} className="cut cut-card kit-cut-demo" style={{ ["--edge" as string]: `var(${edge})`, minHeight: 100 }}>
            <span><code>{edge}</code><br />{use}</span>
          </div>
        ))}
      </div>
      <Section title="Cut components" note="The same shapes as the app's own parts.">
        <div className="kit-row">
          <button className="btn neutral cut cut-btn">Neutral</button>
          <button className="btn money cut cut-btn"><GemaMark size={16} />Money</button>
          <button className="btn neutral cut cut-btn" disabled>Disabled</button>
          <span className="chip cut cut-chip">Chip</span>
          <span className="chip money cut cut-chip">Money chip</span>
          <span className="chip warn cut cut-chip">Warn</span>
          <span className="chip danger cut cut-chip">Danger</span>
        </div>
      </Section>
    </Kit>
  ),
};

/** Focus never uses `outline` on a cut (the clip would break it). The edge itself becomes a 2px ring that follows the chamfers. Money fills take an ink ring set inside instead. */
export const FocusRings: Story = {
  render: () => (
    <Kit>
      <Quote>Focus never uses outline on a cut shape: the clip turns it into a broken rectangle. The edge becomes the ring, 2px solid --fg. Light fills take an ink ring set 3px inside. (DESIGN.md, The cut)</Quote>
      <Section title="Rings shown" note="These are held on so you can see them.">
        <div className="kit-row">
          <button className="btn neutral cut cut-btn kit-ring-on">Neutral</button>
          <button className="btn money cut cut-btn kit-ring-ink"><GemaMark size={16} />Money</button>
          <span className="chip cut cut-chip kit-ring-on">Chip</span>
          <div className="cut cut-card card kit-ring-on" style={{ padding: "12px 16px" }}>Card</div>
        </div>
      </Section>
      <Section title="Try it" note="Press Tab to move through these. The ring shows for the keyboard, not for the mouse.">
        <div className="kit-row">
          <button className="btn neutral cut cut-btn">First</button>
          <button className="btn money cut cut-btn"><GemaMark size={16} />Money</button>
          <button className="btn neutral cut cut-btn">Third</button>
          <button className="btn neutral lg cut cut-btn">Large</button>
        </div>
      </Section>
    </Kit>
  ),
};
