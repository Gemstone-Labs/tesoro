import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ageStore } from "./env";
import { MemoryAgeStore } from "./store";

const configured = new MemoryAgeStore();
const SUPABASE = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };

describe("ageStore", () => {
  it("uses Supabase when it is configured, even in production", () => {
    expect(ageStore({ ...SUPABASE, NODE_ENV: "production" }, configured)).toBe(configured);
    expect(ageStore({ ...SUPABASE, NODE_ENV: "development" }, configured)).toBe(configured);
  });

  it("uses one shared in-memory store in dev without Supabase", () => {
    const a = ageStore({ NODE_ENV: "development" }, configured);
    expect(a).not.toBe(configured);
    expect(a).toBeInstanceOf(MemoryAgeStore);
    expect(ageStore({}, configured)).toBe(a);
  });

  it("throws in production without Supabase", () => {
    expect(() => ageStore({ NODE_ENV: "production" }, configured)).toThrow(/not configured/);
  });
});
