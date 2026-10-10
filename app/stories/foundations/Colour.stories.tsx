import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Kit, Quote, Section } from "../kit/Kit";
import { appTokens, kindOf, lightTokens, type Kind, type Token } from "./css";

const meta = { title: "Foundations/Colour", parameters: { layout: "padded", themed: true } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The value the browser resolves for each token, re-read when the theme changes. */
function useComputed(tokens: Token[]) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => rerender((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(tokens.map((t) => [t.name, cs.getPropertyValue(t.name).trim()]));
}

const TITLES: Record<Kind, string> = { colour: "Solid colours", gradient: "Gradients and edges", font: "Type families", size: "Sizes", other: "Other" };

function TokenTable({ kind }: { kind: Kind }) {
  const rows = appTokens.filter((t) => kindOf(t) === kind);
  const values = useComputed(rows);
  if (!rows.length) return null;
  return (
    <Section title={TITLES[kind]}>
      <table className="kit-table">
        <thead>
          <tr><th>{kind === "font" ? "Sample" : kind === "size" || kind === "other" ? "" : "Swatch"}</th><th>Token</th><th>Computed value</th></tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.name}>
              <td>
                {kind === "colour" || kind === "gradient" ? <span className="kit-swatch" style={{ background: `var(${t.name})` }} /> : kind === "font" ? <span style={{ fontFamily: `var(${t.name})`, fontSize: 18 }}>Gemas 1,250</span> : null}
              </td>
              <td className="mono">{t.name}</td>
              <td className="mono">{values[t.name] || t.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/**
 * Every token in the `:root` block of `globals.css`, with the value the browser computes. The list is read from
 * the file, so a new token appears here without editing the story.
 */
export const AppTokens: Story = {
  render: () => (
    <Kit>
      <Quote>Near-black neutral shell; game art supplies the colour. Emerald appears only where Gemas move. Text uses --fg or --fg-2; --fg-3 is decoration only. (DESIGN.md, Principles and Tokens)</Quote>
      {(["colour", "gradient", "font", "size", "other"] as const).map((k) => <TokenTable key={k} kind={k} />)}
    </Kit>
  ),
};

/** What the landing page's light theme overrides, next to the dark value. Switch the toolbar Theme to see the live tokens above change too. */
export const LandingLightTheme: Story = {
  render: () => {
    const dark = Object.fromEntries(appTokens.map((t) => [t.name, t.value]));
    return (
      <Kit>
        <Quote>The landing page and the docs have a light theme: paper ground, ink text, deeper emerald. Everything not listed here keeps its dark value. (landing.css, :root[data-theme=&quot;light&quot;])</Quote>
        <table className="kit-table">
          <thead>
            <tr><th>Dark / light</th><th>Token</th><th>Dark</th><th>Light</th></tr>
          </thead>
          <tbody>
            {lightTokens.map((t) => {
              const d = dark[t.name];
              const showSwatch = kindOf(t) === "colour" || kindOf(t) === "gradient";
              return (
                <tr key={t.name}>
                  <td>
                    {showSwatch && (
                      <span className="kit-row" style={{ gap: 4 }}>
                        <span className="kit-swatch" style={{ background: d ?? "transparent" }} />
                        <span className="kit-swatch" style={{ background: t.value }} />
                      </span>
                    )}
                  </td>
                  <td className="mono">{t.name}</td>
                  <td className="mono">{d ?? "(landing only)"}</td>
                  <td className="mono">{t.value}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Kit>
    );
  },
};
