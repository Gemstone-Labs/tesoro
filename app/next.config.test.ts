import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("redirects", () => {
  it("sends the Block Burst display-name URL to its Game page", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({ source: "/play/block-burst", destination: "/play/block-puzzle", permanent: false });
  });
});
