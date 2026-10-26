import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Segmented } from "./inputs";

const options = [{ value: "a", label: "Requests" }, { value: "b", label: "My Backings (2)" }];

describe("Segmented", () => {
  it("is a radio group with the chosen option checked and the piece on it", () => {
    const html = renderToStaticMarkup(<Segmented label="Backing view" value="b" onChange={() => {}} options={options} />);
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/value="b"[^>]*checked|checked[^>]*value="b"/);
    expect(html).toContain("--i:1");
    expect(html).toContain("--n:2");
  });
  it("never uses emerald: no money class", () => {
    expect(renderToStaticMarkup(<Segmented label="x" value="a" onChange={() => {}} options={options} />)).not.toContain("money");
  });
});
