import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Kit, Quote, Section } from "../kit/Kit";
import { appTokens } from "./css";
import { fontSizesInUse } from "./css";

const meta = { title: "Foundations/Typography", parameters: { layout: "padded", themed: true } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const FONT_NOTES: Record<string, string> = {
  "--f-body": "UI text and every amount. Weights 400, 700, 800, 900.",
  "--f-display": "Section headers, page titles, game posters, card ranks. 800, all caps.",
  "--f-mono": "Verifiable data only: chain chips, hashes, timers, the simulated-yield label.",
};

/** The three families, each set in its own face. */
export const Families: Story = {
  render: () => (
    <Kit>
      <Quote>Display: Barlow Condensed 800, all caps. UI text and figures: Schibsted Grotesk. Verifiable data: IBM Plex Mono only. (DESIGN.md, Type)</Quote>
      {appTokens.filter((t) => t.name.startsWith("--f-")).map((t) => (
        <Section key={t.name} title={t.name} note={FONT_NOTES[t.name]}>
          <div style={{ fontFamily: `var(${t.name})`, fontSize: 40, fontWeight: t.name === "--f-display" ? 800 : 700, textTransform: t.name === "--f-display" ? "uppercase" : undefined, lineHeight: 1.1 }}>
            Play now, 1,250 Gemas
          </div>
          <div style={{ fontFamily: `var(${t.name})`, fontSize: 16 }}>The quick brown fox jumps over the lazy dog. 0123456789</div>
        </Section>
      ))}
    </Kit>
  ),
};

const SCALE: { cls: string; title: string; note: string; node: React.ReactNode }[] = [
  { cls: "page-title", title: ".page-title", note: "Page titles. 32 to 44 px, fluid.", node: <h1 className="page-title">Your Wallet</h1> },
  { cls: "h-section", title: ".h-section", note: "Section headers. 30 to 48 px, fluid.", node: <h2 className="h-section">Play now</h2> },
  { cls: "display", title: ".display", note: "The same face for anything else that needs it; set the size yourself.", node: <span className="display" style={{ fontSize: 56 }}>Block Puzzle</span> },
  { cls: "row-title", title: ".row-title", note: "List rows keep Schibsted, not the display face.", node: <span className="row-title">Block Puzzle · 1,000 entry</span> },
  { cls: "body", title: "Body (14 px)", note: "The page default.", node: <p>Gemas you win are pending until the Position they came from pays out.</p> },
  { cls: "label", title: ".label", note: "Small uppercase captions.", node: <span className="label">Redeemable now</span> },
  { cls: "meta", title: ".meta", note: "Secondary text. 12.5 px, --fg-2.", node: <span className="meta">12 Matches · 58% won</span> },
  { cls: "mono", title: ".mono", note: "Plex Mono for hashes, chain chips, timers.", node: <span className="mono">7zr1…qh7M · 04:59</span> },
  { cls: "tnum", title: ".tnum", note: "Tabular figures for amounts in lists and tables. Big display figures stay proportional.", node: <span className="tnum">1,111 · 8,888</span> },
];

/** The text classes the app uses, each as the app sets it. */
export const Scale: Story = {
  render: () => (
    <Kit>
      <Quote>Heavy Schibsted (800 to 900) gets word-spacing .14em; Barlow does not need it. Tabular figures on amounts in lists, proportional on big figures.</Quote>
      <table className="kit-table">
        <tbody>
          {SCALE.map((r) => (
            <tr key={r.cls}>
              <td style={{ width: 150 }} className="mono">{r.title}</td>
              <td>{r.node}</td>
              <td className="meta">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Kit>
  ),
};

/** Every plain pixel size the component CSS sets (ui, page, shell, lobby), read from the files, with how many rules use it. */
export const SizesInUse: Story = {
  render: () => (
    <Kit>
      <p className="kit-note">Fluid sizes (clamp) are not listed. More sizes means more to keep in step: use one that is already here.</p>
      <table className="kit-table">
        <thead>
          <tr><th>px</th><th>Rules</th><th>Sample</th></tr>
        </thead>
        <tbody>
          {fontSizesInUse().map((s) => (
            <tr key={s.px}>
              <td className="mono">{s.px}</td>
              <td className="mono">{s.count}</td>
              <td style={{ fontSize: s.px, lineHeight: 1.15 }}>Gemas move, 1,250</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Kit>
  ),
};
