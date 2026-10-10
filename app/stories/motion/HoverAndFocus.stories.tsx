import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { AssetPicker, Button, Chip, EntryPicker, Row, Slider } from "@/components/ui";
import type { EntrySize } from "@/lib/mock";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { SearchProvider } from "@/components/shell/SearchContext";
import "./motion.css";

function Demo({ ms }: { ms: number }) {
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const [h, setH] = useState(3);
  return (
    <div className="sbm sbm-trans">
      {ms >= 0 && <style>{`.sbm-trans *, .sbm-trans *::before, .sbm-trans *::after { transition-duration: ${ms}ms !important; }`}</style>}
      <div className="sbm-panel">
        <h3>Buttons (ui.css:116: filter, background and press, 0.15 s)</h3>
        <div className="sbm-row">
          <Button variant="money">Play now</Button>
          <Button>Practice</Button>
          <Button size="sm">Small</Button>
          <Button variant="money" disabled>Disabled</Button>
          <a className="btn money cut cut-btn lp-shine" href="#shine">Hover for the shine (0.7 s)</a>
        </div>
      </div>
      <div className="sbm-panel">
        <h3>Pickers (ui.css:196, 206: background, 0.15 s)</h3>
        <div className="sbm-row">
          <EntryPicker value={entry} onChange={setEntry} name="sbm-entry" />
          <AssetPicker value={asset} onChange={setAsset} name="sbm-asset" />
          <Chip tone="strong">Chip</Chip>
        </div>
        <Slider label="Horizon" value={h} min={1} max={12} onChange={setH} display={`${h} months`} />
      </div>
      <div className="sbm-panel">
        <h3>Rows (shell.css:177, block-puzzle.css:128, lobby.css:202: background, 0.15 to 0.2 s)</h3>
        <Row title="Block Puzzle" meta="Won 900 · 2 min ago" cta="Open" href="#row" />
        <Row title="Hold'em" meta="Lost 500 · 1 h ago" cta="Open" href="#row2" />
      </div>
      <div className="sbm-panel">
        <h3>Game tiles (lobby.css:195: tilt follows the mouse, 0.6 s back to flat, 0.15 s while hovered; art zoom 0.6 s)</h3>
        <SearchProvider>
          <PlayNowRail />
        </SearchProvider>
      </div>
    </div>
  );
}

const meta = {
  title: "Motion/Hover and focus",
  component: Demo,
  parameters: { layout: "padded" },
  args: { ms: -1 },
  argTypes: { ms: { control: { type: "range", min: -1, max: 2000, step: 50 }, description: "Transition duration for everything below, in ms. -1 leaves each one as built." } },
} satisfies Meta<typeof Demo>;
export default meta;

/** Move the pointer over the controls; use Controls to slow every transition down. */
export const Transitions: StoryObj<typeof meta> = {};
