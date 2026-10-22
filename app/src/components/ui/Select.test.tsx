import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select, selectKeyTarget } from "./Select";

const labels = ["No limit", "500 Gemas", "1,000 Gemas", "5,000 Gemas"];

describe("Select keys", () => {
  it("moves with the arrows and stops at the ends", () => {
    expect(selectKeyTarget("ArrowDown", 0, labels)).toBe(1);
    expect(selectKeyTarget("ArrowDown", 3, labels)).toBe(3);
    expect(selectKeyTarget("ArrowUp", 0, labels)).toBe(0);
    expect(selectKeyTarget("ArrowDown", -1, labels)).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(selectKeyTarget("Home", 2, labels)).toBe(0);
    expect(selectKeyTarget("End", 0, labels)).toBe(3);
  });

  it("jumps to the next label starting with a typed letter, wrapping round", () => {
    expect(selectKeyTarget("5", 0, labels)).toBe(1);
    expect(selectKeyTarget("5", 1, labels)).toBe(3);
    expect(selectKeyTarget("5", 3, labels)).toBe(1);
    expect(selectKeyTarget("n", 2, labels)).toBe(0);
    expect(selectKeyTarget("z", 0, labels)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(selectKeyTarget(" ", 0, labels)).toBeNull();
    expect(selectKeyTarget("Shift", 0, labels)).toBeNull();
  });
});

describe("Select", () => {
  const html = renderToStaticMarkup(
    <Select id="game" value="holdem" options={[{ value: "block-puzzle", label: "Block Burst" }, { value: "holdem", label: "Buckshot Hold'em" }]} onChange={() => {}} />,
  );

  it("shows the chosen label on a combobox button in a control frame", () => {
    expect(html).toMatch(/<span class="cut cut-chip ctl"><button id="game" type="button" role="combobox" class="select"[^>]*aria-expanded="false"[^>]*>Buckshot Hold&#x27;em<\/button><\/span>/);
  });

  it("keeps its list closed and out of the page until opened", () => {
    expect(html).toContain('popover="manual"');
    expect(html).not.toContain('role="option"');
  });
});

/** The browser's own option list ignores our surfaces (it showed white with unreadable text): use Select. */
describe("no native selects", () => {
  const src = join(__dirname, "../..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("renders every dropdown with components/ui/Select", () => {
    const native = files(src).filter((f) => /<select[\s>]/.test(readFileSync(f, "utf8")));
    expect(native, "use <Select> from @/components/ui instead of a native <select>").toEqual([]);
  });
});
