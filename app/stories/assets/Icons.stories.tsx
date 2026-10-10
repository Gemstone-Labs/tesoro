import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Kit, Quote, Section, Tile } from "../kit/Kit";

const meta = { title: "Assets/App icons and cards", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj;

const served = Object.keys(import.meta.glob("/public/icons/*")).map((p) => p.replace("/public", ""));
const routed = import.meta.glob("/src/app/*.{png,ico}", { query: "?url", import: "default", eager: true }) as Record<string, string | { src: string }>;

/** Installed-app icons from `public/icons` (the web manifest) and the files next to the routes in `src/app` (favicon, social cards). All are rendered from the Facet T by `scripts/build-brand.mjs`. */
export const Icons: Story = {
  render: () => (
    <Kit>
      <Quote>Icons and social cards are rendered from the vector by build-brand.mjs: favicon.ico (16/32/48), icon.png, apple-icon.png, the manifest 192/512 icons, the maskable 512 and the 1200 × 630 opengraph and twitter images. (DESIGN.md, Logo)</Quote>
      <Section title="Manifest icons" note="Served from /icons.">
        <div className="kit-grid" style={{ ["--min" as string]: "200px" }}>
          {served.map((p) => <Tile key={p} path={p} ground="checker" maxH={160} />)}
        </div>
      </Section>
      <Section title="Route files" note="These are served by Next from src/app, not from /. Storybook shows the file; the path to copy is the one in the repo.">
        <div className="kit-grid" style={{ ["--min" as string]: "220px" }}>
          {Object.entries(routed).map(([src, url]) => (
            <RouteFile key={src} repoPath={`app${src}`} url={typeof url === "string" ? url : url.src} />
          ))}
        </div>
      </Section>
    </Kit>
  ),
};

function RouteFile({ repoPath, url }: { repoPath: string; url: string }) {
  return <Tile path={url} label={repoPath.split("/").pop()} ground="checker" maxH={160} copy={repoPath} />;
}

/** The back of every Hold'em card: the Facet T in steel, never emerald. */
export const CardBack: Story = {
  render: () => (
    <Kit>
      <div className="kit-grid" style={{ ["--min" as string]: "220px" }}>
        <Tile path="/art/card-back.svg" ground="checker" maxH={280} />
      </div>
    </Kit>
  ),
};
