import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Battle } from "./decode";
import { EndWhy } from "./EndWhy";
import { endLine } from "./end";

const over = { status: 3, winner: 0, reason: 0 } as Battle;

describe("EndWhy", () => {
  it("gives the title and the sentence on the result screen", () => {
    const html = renderToStaticMarkup(<EndWhy battle={over} seat={0} />);
    expect(html).toContain("Supply Truck captured");
    expect(html).toContain(endLine(over, 0));
  });

  it("gives only the title where the board already says the sentence", () => {
    const html = renderToStaticMarkup(<EndWhy battle={over} seat={0} titleOnly />);
    expect(html).toContain("Supply Truck captured");
    expect(html).not.toContain(endLine(over, 0));
  });
});
