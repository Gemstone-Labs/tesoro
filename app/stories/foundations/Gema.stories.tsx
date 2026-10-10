import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Kit, Quote, Section } from "../kit/Kit";
import { GemaAmount, GemaMark, SimulatedYieldLabel } from "@/components/ui/gema";

const meta = { title: "Foundations/Gema mark and money art", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The currency mark: a small emerald-cut stone. Move the controls to try size and glint. */
export const Mark: StoryObj<{ size: number; glint: boolean }> = {
  args: { size: 48, glint: false },
  argTypes: { size: { control: { type: "range", min: 12, max: 160, step: 2 } } },
  render: ({ size, glint }) => (
    <Kit>
      <Quote>A small emerald-cut stone, never a flat diamond glyph, never gold. It precedes Gema amounts of consequence. It is not the logo. A brief glint is allowed on the balance only. (DESIGN.md, The Gema mark)</Quote>
      <div className="kit-row"><GemaMark size={size} glint={glint} /></div>
      <Section title="Sizes in the app">
        <div className="kit-row" style={{ alignItems: "end" }}>
          {[14, 16, 20, 30, 64].map((s) => <div key={s} className="stack" style={{ justifyItems: "center" }}><GemaMark size={s} /><span className="meta">{s}</span></div>)}
        </div>
      </Section>
    </Kit>
  ),
};

/** `GemaAmount` in each size, with a sign, without the mark, and the yield label that goes with simulated amounts. */
export const Amounts: Story = {
  render: () => (
    <Kit>
      <Section title="Sizes" note="sm, md, lg, xl.">
        <div className="kit-row" style={{ gap: 28 }}>
          {(["sm", "md", "lg", "xl"] as const).map((s) => <GemaAmount key={s} value={1250} size={s} />)}
        </div>
      </Section>
      <Section title="Signs" note="A gain or loss always carries a sign as well as colour.">
        <div className="kit-row" style={{ gap: 28 }}>
          <GemaAmount value={900} sign />
          <GemaAmount value={-500} sign />
          <GemaAmount value={0} sign />
          <GemaAmount value={1250} mark={false} />
          <GemaAmount value={2500} glint size="lg" />
        </div>
      </Section>
      <Section title="Simulated yield label">
        <SimulatedYieldLabel />
      </Section>
    </Kit>
  ),
};

/** On a money fill the mark is drawn in ink so it blends in. Disabled money buttons keep the full-colour mark. */
export const OnMoneyFills: Story = {
  render: () => (
    <Kit>
      <div className="kit-row">
        <button className="btn money cut cut-btn"><GemaMark size={16} />Enter 1,000</button>
        <button className="btn money lg cut cut-btn"><GemaMark size={20} />Play now</button>
        <button className="btn money cut cut-btn" disabled><GemaMark size={16} />Enter 1,000</button>
      </div>
    </Kit>
  ),
};

/** The facet crown: an emerald step cut seen from above, shown low in the Wallet balance panel. Money surfaces only. */
export const FacetCrown: Story = {
  render: () => (
    <Kit>
      <Quote>public/brand/facet-crown.svg sits low in the Wallet balance panel (.facet-panel), showing only its lit upper facets, clear of every figure. Money surfaces only. (DESIGN.md, Money art)</Quote>
      <Section title="In the panel">
        <section className="cut cut-frame facet-panel" style={{ minHeight: 220, padding: 24, maxWidth: 720 }}>
          <span className="label">Balance</span>
          <div style={{ marginTop: 8 }}><GemaAmount value={12480} size="xl" /></div>
        </section>
      </Section>
      <Section title="The whole file">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/facet-crown.svg" alt="" style={{ height: 240, background: "#0b2c26", padding: 12 }} />
      </Section>
    </Kit>
  ),
};
