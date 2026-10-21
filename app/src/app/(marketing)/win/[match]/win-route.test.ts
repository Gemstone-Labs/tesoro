import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WinCardData } from "@/lib/win-card";

const WIN: WinCardData = { id: "9A69cBNqH3w2YqW1ZxKtRrQmLyV8bDfE4cNhUjSgPoTa-7", game: "block-puzzle", entry: 1000, gemas: 780, name: "Ana", avatar: 5, hex: "#9CC8F2" };
const KEY = "9A69cBNqH3w2YqW1ZxKtRrQmLyV8bDfE4cNhUjSgPoTa-7";
const loadWin = vi.fn();

vi.mock("@/server/win-card", () => ({ loadWin: (id: unknown) => loadWin(id) }));
vi.mock("@/server/spot-card", () => ({
  CARD: { width: 1200, height: 630 },
  winCard: async () => new Response("png", { headers: { "content-type": "image/png" } }),
}));
vi.mock("@/components/win/win.css", () => ({}));

const params = (match: string) => ({ params: Promise.resolve({ match }) });
const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") });

beforeEach(() => loadWin.mockReset());

describe("/win/[match]/card", () => {
  it("serves the image of a won, settled Match", async () => {
    loadWin.mockResolvedValue(WIN);
    const { GET } = await import("./card/route");
    const res = await GET(new Request("http://x/win/x/card"), params(KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(loadWin).toHaveBeenCalledWith({ opener: "9A69cBNqH3w2YqW1ZxKtRrQmLyV8bDfE4cNhUjSgPoTa", n: 7n });
  });
  it("404s for a Match without a card, and never reads the chain for a bad id", async () => {
    const { GET } = await import("./card/route");
    loadWin.mockResolvedValue(null);
    await notFound(GET(new Request("http://x"), params(KEY)));
    loadWin.mockClear();
    await notFound(GET(new Request("http://x"), params("abc")));
    expect(loadWin).not.toHaveBeenCalled();
  });
});

describe("/win/[match]", () => {
  it("sets og:image and twitter:image on the card, summary_large_image", async () => {
    loadWin.mockResolvedValue(WIN);
    const { generateMetadata } = await import("./page");
    const meta = await generateMetadata(params(KEY));
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: `/win/${KEY}/card`, width: 1200, height: 630 }] });
    expect(meta.openGraph).toMatchObject({ images: [{ url: `/win/${KEY}/card`, width: 1200, height: 630 }] });
  });
  it("has no metadata and 404s for a Match without a card", async () => {
    loadWin.mockResolvedValue(null);
    const { default: Page, generateMetadata } = await import("./page");
    expect(await generateMetadata(params(KEY))).toEqual({});
    await notFound(Page(params(KEY)));
    await notFound(Page(params("0")));
  });
  it("renders the page for a win", async () => {
    loadWin.mockResolvedValue(WIN);
    const { default: Page } = await import("./page");
    expect(await Page(params(KEY))).toBeTruthy();
  });
});
