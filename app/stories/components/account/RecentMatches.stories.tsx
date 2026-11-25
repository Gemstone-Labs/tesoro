import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RecentMatches } from "@/components/account/RecentMatches";
import type { PlayedRow } from "@/lib/chain/player-account";
import { DEMO_ME } from "../../support/data";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const row = (id: string, delta: number, agoMs: number, opp: string | null): PlayedRow => ({
  id,
  game: "block-puzzle",
  entry: 100,
  role: "player",
  result: delta > 0 ? "won" : delta < 0 ? "lost" : "draw",
  delta,
  backing: null,
  scores: null,
  opp,
  at: NOW - agoMs,
  asset: null,
  backerDelta: null,
});

const meta = {
  title: "Components/account/RecentMatches",
  component: RecentMatches,
  parameters: { layout: "padded", shell: "app" },
} satisfies Meta<typeof RecentMatches>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Amount and time of different widths (−100 31m, +1,234 6h, 0 2d, no opponent): each sits in its own right-aligned column. */
export const AlignedColumns: Story = {
  args: { now: NOW, rows: [row("a", -100, 31 * 60_000, DEMO_ME), row("b", 1_234, 6 * 3_600_000, DEMO_ME), row("c", 0, 2 * 86_400_000, null)] },
};
export const AlignedColumns390: Story = { ...AlignedColumns, globals: { viewport: { value: "phone390", isRotated: false } } };
export const AlignedColumns1440: Story = { ...AlignedColumns, globals: { viewport: { value: "desktop1440", isRotated: false } } };
