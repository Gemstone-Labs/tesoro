import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockPuzzleGame } from "./BlockPuzzleGame";

describe("Block Burst practice", () => {
  it("opens on the board with no rules card or Start button (it counts 3-2-1 by itself)", () => {
    const html = renderToStaticMarkup(<BlockPuzzleGame />);
    expect(html).toContain("bpx");
    expect(html).not.toContain("Start practice");
    expect(html).not.toContain("bp-rules");
  });
});
