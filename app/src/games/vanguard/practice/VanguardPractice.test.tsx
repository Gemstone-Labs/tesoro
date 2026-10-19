import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VanguardPractice } from "./VanguardPractice";

describe("Vanguard Practice on the server", () => {
  it("renders the same HTML every time: the random setup is drawn in the browser, so hydration matches", () => {
    const first = renderToString(<VanguardPractice />);
    const second = renderToString(<VanguardPractice />);
    expect(first).toBe(second);
  });
});
