import { describe, expect, it } from "vitest";
import { isIndexable, resolveSiteUrl } from "./site";

describe("resolveSiteUrl", () => {
  it("prefers NEXT_PUBLIC_SITE_URL and trims the slash", () => {
    expect(resolveSiteUrl({ explicit: "https://test.playtesoro.com/", cluster: "test", production: true })).toBe("https://test.playtesoro.com");
  });
  it("falls back to the Vercel production domain", () => {
    expect(resolveSiteUrl({ vercelProductionUrl: "tesoro-test.vercel.app", cluster: "test", production: true })).toBe("https://tesoro-test.vercel.app");
  });
  it("defaults by cluster in a production build: test never claims www", () => {
    expect(resolveSiteUrl({ cluster: "test", production: true })).toBe("https://test.playtesoro.com");
    expect(resolveSiteUrl({ cluster: "mainnet", production: true })).toBe("https://www.playtesoro.com");
  });
  it("uses localhost outside production builds", () => {
    expect(resolveSiteUrl({ cluster: "mainnet", production: false })).toBe("http://localhost:3000");
  });
});

describe("isIndexable", () => {
  it("allows www only", () => {
    expect(isIndexable("https://www.playtesoro.com")).toBe(true);
    expect(isIndexable("https://test.playtesoro.com")).toBe(false);
    expect(isIndexable("https://tesoro-fawn.vercel.app")).toBe(false);
    expect(isIndexable("http://localhost:3000")).toBe(false);
    expect(isIndexable("not a url")).toBe(false);
  });
});
