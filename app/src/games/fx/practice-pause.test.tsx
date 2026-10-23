import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockPuzzleGame } from "../block-puzzle/BlockPuzzleGame";
import { VgBar } from "../vanguard/VanguardScreen";
import { PracticePauseButton, PracticePauseOverlay } from "./PracticePause";

const pause = <PracticePauseButton paused={false} onToggle={() => {}} />;
describe("practice pause controls", () => {
  it("offers pause in Block Burst practice, never in a real Match", () => {
    expect(renderToStaticMarkup(<BlockPuzzleGame />)).toContain('aria-label="Pause"');
    const run = { seed: 1n, startedAt: 0, entry: 500, onMove: () => {}, onEnd: () => {} };
    expect(renderToStaticMarkup(<BlockPuzzleGame run={run} />)).not.toContain('aria-label="Pause"');
  });
  it("keeps Vanguard pause beside its menu in Practice only", () => {
    expect(renderToStaticMarkup(<VgBar practice pause={pause} onRules={() => {}} />)).toContain('aria-label="Pause"');
    expect(renderToStaticMarkup(<VgBar pause={pause} onRules={() => {}} />)).not.toContain('aria-label="Pause"');
  });
  it("uses the play icon control and a short Resume overlay while paused", () => {
    const html = renderToStaticMarkup(<PracticePauseButton paused onToggle={() => {}} />);
    expect(html).toContain('aria-label="Resume"');
    expect(html).toContain('aria-pressed="true"');
    const overlay = renderToStaticMarkup(<PracticePauseOverlay onResume={() => {}} />);
    expect(overlay).toContain('aria-label="Paused"');
    expect(overlay).toContain("Resume");
    expect(overlay).not.toMatch(/<p[\s>]/);
  });
});
