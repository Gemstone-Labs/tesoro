import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { art, avatarFor } from "@/lib/art";
import { Kit, Quote, Section, Tile } from "../kit/Kit";

const meta = { title: "Assets/Game art", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj;

const flat = (o: Record<string, string | { src: string }>) => Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v : v.src] as const);
const GRID = { ["--min" as string]: "220px" };

function Gallery({ title, note, items, maxH }: { title: string; note?: string; items: readonly (readonly [string, string])[]; maxH?: number }) {
  return (
    <Section title={`${title} (${items.length})`} note={note}>
      <div className="kit-grid" style={GRID}>
        {items.map(([k, src]) => <Tile key={k + src} path={src} label={k} maxH={maxH} />)}
      </div>
    </Section>
  );
}

/** Everything in `src/lib/art.ts`, listed from the map. Add art there and it shows up here. */
export const Manifest: Story = {
  render: () => (
    <Kit>
      <Quote>All game art, hero art and avatars come from one map, app/src/lib/art.ts. Art carries no UI text. Hero art keeps its left 40% dark for the title. (DESIGN.md, Art)</Quote>
      <Gallery title="Heroes" note="Wide 2400 × 1000, left 40% empty for the title." items={[["blockPuzzleHero", art.blockPuzzleHero], ["holdemHero", art.holdemHero], ["tradingDuelHero", art.tradingDuelHero]]} />
      <Gallery title="Tiles" note="Square key art." items={[["blockPuzzleTile", art.blockPuzzleTile], ["holdemTile", art.holdemTile], ["tradingDuelTile", art.tradingDuelTile]]} />
      <Gallery title="Coming soon" items={flat(art.comingSoon)} />
      <Gallery title="Game thumbs" note="The square tiles, cropped by CSS." items={flat(art.thumb)} />
      <Gallery title="Busts" note="Torso-up crops of the guide characters: him is the Player, her is the Backer." items={flat(art.busts)} />
      <Gallery title="Guide poses" note="Large crops for the Guide overlay." items={flat(art.guide)} />
      <Gallery title="Avatars" note="Gemstone animal heads. Never people, never green." items={art.avatars.map((a, i) => [`avatar-${i + 1}`, a] as const)} maxH={140} />
    </Kit>
  ),
};

/** The avatar a Player key gets. The same key always gives the same animal. */
export const AvatarFor: StoryObj<{ key_: string }> = {
  args: { key_: "DA9K4qeEmPXx2fT7Zr1uYbVhN8cQwL3sJgAo5ktP1bS" },
  argTypes: { key_: { name: "Player key", control: "text" } },
  render: ({ key_ }) => <AvatarDemo initial={key_} />,
};

function AvatarDemo({ initial }: { initial: string }) {
  const [key, setKey] = useState(initial);
  const src = avatarFor(key);
  return (
    <Kit>
      <Quote>A stable avatar for a Player key, so the same Player always shows the same avatar. (src/lib/art.ts, avatarFor)</Quote>
      <label className="kit-field">Player key<input value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} /></label>
      <div className="kit-grid" style={{ ["--min" as string]: "240px" }}>
        <Tile path={src} maxH={200} />
      </div>
      <Section title="Spread" note="Ten sample keys.">
        <div className="kit-row">
          {Array.from({ length: 10 }, (_, i) => `${key}-${i}`).map((k) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={k} src={avatarFor(k)} alt="" width={64} height={64} loading="lazy" title={k} />
          ))}
        </div>
      </Section>
    </Kit>
  );
}
