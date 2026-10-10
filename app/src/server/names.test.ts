import { describe, expect, it, vi } from "vitest";
import { NameCache, parseRequest, resolveNames, safeImageUrl, type NameSources } from "./names";

const W1 = "11111111111111111111111111111112";
const W2 = "So11111111111111111111111111111111111111112";
const E1 = "0x52908400098527886E0F7030069857D2E4169EE7";

function sources(over: Partial<NameSources> = {}): NameSources {
  return {
    solPrimary: vi.fn(async (ws: { toBase58(): string }[]) => ws.map((w) => (w.toBase58() === W1 ? "ana" : undefined))),
    ensName: vi.fn(async () => "ana.eth"),
    ensAvatar: vi.fn(async () => "ipfs://nope"),
    ...over,
  };
}

describe("resolveNames", () => {
  it("returns names with suffixes, drops non-https avatars and caches", async () => {
    const s = sources();
    const cache = new NameCache();
    const req = { solana: [W1, W2], evm: [E1] };
    const out = await resolveNames(req, s, cache);
    expect(out.solana[W1]).toEqual({ name: "ana.sol", avatar: null });
    expect(out.solana[W2]).toBeNull();
    expect(out.evm[E1]).toEqual({ name: "ana.eth", avatar: null });
    await resolveNames(req, s, cache);
    expect(s.solPrimary).toHaveBeenCalledTimes(1);
    expect(s.ensName).toHaveBeenCalledTimes(1);
  });

  it("treats a failing registry as no name, and retries soon", async () => {
    const s = sources({ solPrimary: vi.fn().mockRejectedValue(new Error("rpc")), ensName: vi.fn().mockRejectedValue(new Error("rpc")) });
    const cache = new NameCache();
    const out = await resolveNames({ solana: [W1], evm: [E1] }, s, cache, 1000);
    expect(out.solana[W1]).toBeNull();
    expect(out.evm[E1]).toBeNull();
    await resolveNames({ solana: [W1], evm: [E1] }, s, cache, 1000 + 31_000);
    expect(s.solPrimary).toHaveBeenCalledTimes(2);
  });

  it("refuses names with odd characters", async () => {
    const s = sources({ solPrimary: vi.fn(async () => ["a b<script>"]) });
    const out = await resolveNames({ solana: [W1], evm: [] }, s, new NameCache());
    expect(out.solana[W1]).toBeNull();
  });
});

describe("parseRequest", () => {
  it("accepts addresses, normalises and dedupes", () => {
    expect(parseRequest({ solana: [W1, W1], evm: [E1.toLowerCase()] })).toEqual({ solana: [W1], evm: [E1] });
  });
  it("rejects malformed input", () => {
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest({ solana: ["nope"], evm: [] })).toBeNull();
    expect(parseRequest({ solana: [], evm: ["0x12"] })).toBeNull();
    expect(parseRequest({ solana: Array(51).fill(W1), evm: [] })).toBeNull();
  });
});

describe("safeImageUrl", () => {
  it("allows https only", () => {
    expect(safeImageUrl("https://a.b/c.png")).toBe("https://a.b/c.png");
    for (const bad of ["http://a.b/c.png", "javascript:alert(1)", "data:image/png;base64,AA", "ipfs://x", "", 5]) expect(safeImageUrl(bad)).toBeNull();
  });
});
