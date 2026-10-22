import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Select, Sheet } from "@/components/ui";
import "@/app/(app)/backing/backing.css";

const LIMITS = [0, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000].map((g) => ({ value: g, label: g === 0 ? "No limit" : `${g.toLocaleString("en-US")} Gemas` }));
const GAMES = [
  { value: "block-puzzle", label: "Block Burst" },
  { value: "holdem", label: "Buckshot Hold'em" },
  { value: "trading-duel", label: "Trading Duel" },
];
const SORTS = [
  { value: "recent", label: "Newest" },
  { value: "entry", label: "Biggest entry" },
  { value: "record", label: "Best win rate" },
];

function Framed() {
  const [v, setV] = useState(0);
  return (
    <div className="field" style={{ maxWidth: 260 }}>
      <label className="label" htmlFor="story-limit">Change your limit</label>
      <Select id="story-limit" value={v} options={LIMITS} onChange={setV} />
    </div>
  );
}

const meta = { title: "Components/ui/Select", component: Framed } satisfies Meta<typeof Framed>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A dropdown in a control frame: the list is a raised cut card, never the browser's own white list. */
export const Default: Story = {};

/** Inside a scrolling sheet the list still shows whole: it opens in the top layer. */
export const InSheet: Story = {
  render: function Render() {
    const [game, setGame] = useState("block-puzzle");
    const [limit, setLimit] = useState(0);
    return (
      <Sheet open onClose={() => {}} title="Post a Request">
        <div className="stack">
          <div className="field">
            <label className="label" htmlFor="story-game">Game</label>
            <Select id="story-game" value={game} options={GAMES} onChange={setGame} />
          </div>
          <div className="field">
            <label className="label" htmlFor="story-sheet-limit">Change your limit</label>
            <Select id="story-sheet-limit" value={limit} options={LIMITS} onChange={setLimit} />
          </div>
        </div>
      </Sheet>
    );
  },
};

/** Bare, in a frame of its own: the Backing board's sort. */
export const Sort: Story = {
  render: function Render() {
    const [sort, setSort] = useState("recent");
    return (
      <div className="cut cut-card bk-sort sel-host" style={{ width: "fit-content" }}>
        <span aria-hidden="true">Sort by</span>
        <Select framed={false} aria-label="Sort by" value={sort} options={SORTS} onChange={setSort} />
      </div>
    );
  },
};
