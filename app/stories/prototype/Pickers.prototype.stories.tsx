// PROTOTYPE ONLY (branch proto/pickers-11-10-2026): the four picker directions side by side, plus the real
// components on a game hero and in a sheet, following the pink bar. Delete with pickers.prototype.tsx.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { AssetPicker, Button, CheckIcon, Chip, ClockIcon, EntryPicker, GemaAmount, Slider, XIcon } from "@/components/ui";
import { PICKER_VARIANTS, PickerVariantPin, usePickerVariant, type PickerVariant } from "@/components/ui/pickers.prototype";
import type { EntrySize } from "@/lib/mock";
import { fmtGemas } from "@/lib/format";
import { art } from "@/lib/art";
import "./pickers-gallery.css";

function Set({ compact }: { compact?: boolean }) {
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const [h, setH] = useState(3);
  const [lev, setLev] = useState(5);
  const [ret, setRet] = useState(800);
  return (
    <div className="ppg-set">
      <div className="ppg-cell">
        <span className="ppg-k">Entry</span>
        <EntryPicker value={entry} onChange={setEntry} />
        <span className="ppg-k">Entry, balance 1,200</span>
        <EntryPicker value={1000} onChange={() => {}} maxAffordable={1200} />
      </div>
      <div className="ppg-cell">
        <span className="ppg-k">Asset (Trading Duel)</span>
        <AssetPicker value={asset} onChange={setAsset} />
        <span className="ppg-k">Chips</span>
        <div className="ppg-chips">
          <Chip>Neutral</Chip>
          <Chip tone="strong" icon={<CheckIcon />}>Applied</Chip>
          <Chip tone="money" icon={<CheckIcon />}>Won</Chip>
          <Chip tone="danger" icon={<XIcon />}>Lost</Chip>
          <Chip tone="warn">Simulated</Chip>
          <Chip tone="strong">{fmtGemas(1000)} reserved</Chip>
          <Chip icon={<ClockIcon />}>14 h left</Chip>
        </div>
      </div>
      {!compact && (
        <div className="ppg-cell ppg-sliders">
          <Slider label="Horizon" value={h} min={1} max={12} onChange={setH} display={`${h} ${h === 1 ? "month" : "months"}`} minLabel="1 month" maxLabel="12 months" />
          <Slider label="Leverage" value={lev} min={1} max={20} onChange={setLev} display={`${lev}x`} minLabel="1x" maxLabel="20x" />
          <Slider label="Gemas to return" value={ret} min={0} max={2400} step={50} onChange={setRet} display={<GemaAmount value={ret} size="md" />} minLabel="0" maxLabel="2,400" />
        </div>
      )}
    </div>
  );
}

function Compare() {
  return (
    <div className="ppg">
      {PICKER_VARIANTS.map((v) => (
        <section key={v.key} className="cut ppg-panel">
          <h3>
            <b>{v.key}</b> {v.name}
          </h3>
          <PickerVariantPin.Provider value={v.key as PickerVariant}>
            <Set />
          </PickerVariantPin.Provider>
        </section>
      ))}
    </div>
  );
}

/** The real components where they live: over a game's key art, and in the Open a Position sheet. Follows the bar. */
function InPlace() {
  const v = usePickerVariant();
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const [h, setH] = useState(3);
  return (
    <div className="ppg-place">
      <p className="ppg-now">
        Variant <b>{v}</b> · {PICKER_VARIANTS.find((x) => x.key === v)?.name} (pink bar or ← → to switch)
      </p>
      <section className="cut cut-frame ppg-hero" style={{ backgroundImage: `url(${art.tradingDuelHero})` }}>
        <div className="ppg-hero-body">
          <h1 className="ppg-title">Trading Duel</h1>
          <AssetPicker value={asset} onChange={setAsset} name="pl-asset" />
          <EntryPicker value={entry} onChange={setEntry} name="pl-entry" />
          <Button variant="money" size="lg" block>Play now · {fmtGemas(entry)} Gemas</Button>
        </div>
      </section>
      <section className="cut cut-frame ppg-sheet">
        <h2>Open a Position</h2>
        <Slider label="Horizon" value={h} min={1} max={12} onChange={setH} display={`${h} ${h === 1 ? "month" : "months"}`} minLabel="1 month" maxLabel="12 months" />
        <dl className="cut cut-card ppg-quote">
          <dt>Gemas issued</dt>
          <dd><GemaAmount value={70 * h * 10} size="md" /></dd>
          <dt>Unlock Estimate</dt>
          <dd>{h * 10} min</dd>
        </dl>
        <div className="ppg-chips">
          <Chip tone="warn">Simulated</Chip>
          <Chip tone="money" icon={<CheckIcon />}>Funded</Chip>
        </div>
      </section>
    </div>
  );
}

const meta = { title: "Prototype/Pickers", parameters: { layout: "padded" } } satisfies Meta;
export default meta;

/** All five side by side (A Rail, B Stones, C Tickets, D Quiet type, current). Every control is live. */
export const SideBySide: StoryObj = { render: () => <Compare /> };
/** The real components on a game hero and in a sheet. Switch with the pink bar. */
export const InContext: StoryObj = { render: () => <InPlace /> };
