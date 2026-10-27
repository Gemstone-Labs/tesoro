import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { depositAckStore } from "./env";
import { MemoryDepositAckStore } from "./store";

const configured = new MemoryDepositAckStore();
const SUPABASE = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };

describe("depositAckStore", () => {
  it("uses Supabase when it is configured, even in production", () => {
    expect(depositAckStore({ ...SUPABASE, NODE_ENV: "production" }, configured)).toBe(configured);
    expect(depositAckStore({ ...SUPABASE, NODE_ENV: "development" }, configured)).toBe(configured);
  });

  it("uses one shared in-memory store in dev without Supabase", () => {
    const a = depositAckStore({ NODE_ENV: "development" }, configured);
    expect(a).not.toBe(configured);
    expect(a).toBeInstanceOf(MemoryDepositAckStore);
    expect(depositAckStore({}, configured)).toBe(a);
  });

  it("throws in production without Supabase", () => {
    expect(() => depositAckStore({ NODE_ENV: "production" }, configured)).toThrow(/not configured/);
  });
});
