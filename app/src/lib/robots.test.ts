import { describe, expect, it } from "vitest";
import { robotsFor } from "./robots";

describe("robotsFor", () => {
  it("disallows everything on a host that is not indexable", () => {
    expect(robotsFor("https://test.playtesoro.com", false)).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
  it("allows crawling on the production host, but not the API", () => {
    expect(robotsFor("https://www.playtesoro.com", true)).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
      host: "https://www.playtesoro.com",
    });
  });
});
