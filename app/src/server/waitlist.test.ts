import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({
    upsert,
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { id: 42 } }) }),
      lte: async () => ({ count: 7 }),
    }),
  }) }),
}));

import { join } from "./waitlist";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://test.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only");
  upsert.mockReset().mockResolvedValue({ error: null });
});

describe("waitlist role storage", () => {
  it("includes selected roles and studio in the row without changing duplicate handling", async () => {
    expect(await join("a@example.com", { roles: ["player", "studio"], studio: "Example studio", source: "invite" })).toBe(7);
    expect(upsert).toHaveBeenCalledWith(
      { email: "a@example.com", roles: ["player", "studio"], studio: "Example studio", source: "invite", referrer: null },
      { onConflict: "email", ignoreDuplicates: true },
    );
  });
  it("stores an empty selection when the optional question is skipped", async () => {
    await join("a@example.com", {});
    expect(upsert).toHaveBeenCalledWith(
      { email: "a@example.com", roles: [], studio: null, source: null, referrer: null },
      { onConflict: "email", ignoreDuplicates: true },
    );
  });
});
