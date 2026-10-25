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

describe("VanguardBoard Dust Storm", () => {
  it("draws the storm inside a box the size of the board, so an edge line never spills over the frame", () => {
    const h = renderToStaticMarkup(
      <VanguardBoard pieces={[]} depots={[]} selected={null} marks={[]} fx={[]} storm={{ key: 1, axis: "row", index: 0, dir: 1 }} locked onPiece={() => undefined} onMark={() => undefined} />,
    );
    expect(h).toMatch(/<span class="vg-storm-clip"[^>]*><span class="vg-storm vg-st-row"/);
  });
});

describe("VanguardBoard powers", () => {
  const draw = (extra: Partial<Parameters<typeof VanguardBoard>[0]>) =>
    renderToStaticMarkup(<VanguardBoard pieces={[mine]} depots={[]} selected={1} marks={[]} fx={[]} storm={null} locked={false} onPiece={() => undefined} onMark={() => undefined} {...extra} />);
  it("draws an arc from the piece to a jump mark, and none for an ordinary step", () => {
    expect(draw({ marks: [{ r: 3, c: 4, attack: false, jump: true }] })).toMatch(/class="vg-arc"/);
    expect(draw({ marks: [{ r: 4, c: 4, attack: false }] })).not.toMatch(/vg-arc/);
  });
  it("outlines a Blast's squares and draws the Rescue arrow", () => {
    const squares = [{ r: 4, c: 4 }, { r: 4, c: 5 }];
    expect(draw({ preview: { kind: "blast", squares } }).match(/class="vg-pv"/g)).toHaveLength(2);
    expect(draw({ preview: { kind: "rescue", from: { r: 9, c: 9 }, to: { r: 5, c: 4 } } })).toMatch(/vg-rescue-arrow/);
  });
  it("badges a dug-in Major with its old rank for the owner, and glows an exposed piece", () => {
    const h = draw({ pieces: [{ ...mine, rank: "B", changed: "dug", exposed: true }] });
    expect(h).toContain('<span class="vg-was">7</span>');
    expect(h).toMatch(/class="vg-piece us[^"]* exposed/);
    expect(h).not.toContain("vg-eye");
    expect(h).toContain("was Major");
  });
  it("marks a hopping piece", () => {
    expect(draw({ pieces: [{ ...mine, hop: true, ms: 620 }] })).toMatch(/class="vg-piece us[^"]* hop/);
  });
});
