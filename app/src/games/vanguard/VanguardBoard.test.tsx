import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VanguardBoard, type ShownPiece } from "./VanguardBoard";

const mine: ShownPiece = { id: 1, army: "us", rank: "7", r: 5, c: 4, up: true };
const theirs: ShownPiece = { id: 2, army: "it", rank: null, r: 4, c: 4, up: false };
const other: ShownPiece = { id: 3, army: "it", rank: null, r: 0, c: 0, up: false };

const board = (attack: boolean) =>
  renderToStaticMarkup(
    <VanguardBoard
      pieces={[mine, theirs, other]}
      depots={[]}
      selected={1}
      marks={[{ r: 4, c: 4, attack }]}
      fx={[]}
      storm={null}
      locked={false}
      onPiece={() => undefined}
      onMark={() => undefined}
    />,
  );
const pieceClass = (html: string, label: string) => html.match(new RegExp(`class="([^"]*)"[^>]*aria-label="${label}"`))?.[1] ?? "";

describe("VanguardBoard attack target", () => {
  it("rings the enemy piece you can attack on the piece itself, so the ring follows its tilted rim", () => {
    const h = board(true);
    const targets = h.match(/vg-piece [^"]*\btgt\b/g) ?? [];
    expect(targets).toHaveLength(1);
    expect(pieceClass(h, "Royal Italian Army hidden piece")).toContain("tgt");
    expect(h).toContain('class="vg-mark atk"');
  });
  it("marks no piece when the square is only a move", () => {
    expect(board(false)).not.toMatch(/\btgt\b/);
  });
});
