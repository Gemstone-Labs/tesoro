import { describe, expect, it } from "vitest";
import { parsePanelStyle } from "./panels";

describe("parsePanelStyle", () => {
  it("defaults to take A", () => {
    expect(parsePanelStyle("", null)).toBe("a");
    expect(parsePanelStyle("?x=1", "zzz")).toBe("a");
  });
  it("uses the remembered take", () => {
    expect(parsePanelStyle("", "c")).toBe("c");
  });
  it("lets ?panels win over the remembered take, any case", () => {
    expect(parsePanelStyle("?panels=D", "c")).toBe("d");
  });
  it("ignores an unknown ?panels value", () => {
    expect(parsePanelStyle("?panels=q", "e")).toBe("e");
  });
});
