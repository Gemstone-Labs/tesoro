import { beforeEach, describe, expect, it, vi } from "vitest";

const join = vi.fn();
vi.mock("@/server/waitlist", () => ({ join: (...a: unknown[]) => join(...a) }));
let ip = "1.1.1.1";
let n = 0;
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` }) }));

import { parseEmail } from "@/lib/email";
import { joinWaitlist } from "./waitlist-action";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const idle = { status: "idle" } as const;

beforeEach(() => {
  join.mockReset().mockResolvedValue(undefined);
  ip = `9.9.${Math.floor(++n / 250)}.${n % 250}`;
});

describe("parseEmail", () => {
  it("trims and lowercases", () => expect(parseEmail("  Ana@Example.COM ")).toBe("ana@example.com"));
  it("rejects malformed and overlong", () => {
    for (const bad of ["", "ana", "ana@", "@x.com", "a b@x.com", "ana@x", `${"a".repeat(250)}@x.com`, 5]) expect(parseEmail(bad)).toBeNull();
  });
});

describe("joinWaitlist", () => {
  it("stores a valid email with source and referrer", async () => {
    const r = await joinWaitlist(idle, form({ email: "Ana@Example.com", utm_source: "x", referrer: "https://x.com/" }));
    expect(r).toEqual({ status: "ok" });
    expect(join).toHaveBeenCalledWith("ana@example.com", { source: "x", referrer: "https://x.com/" });
  });
  it("returns the spot", async () => {
    join.mockResolvedValue(142);
    expect(await joinWaitlist(idle, form({ email: "a@b.co" }))).toEqual({ status: "ok", spot: 142 });
  });
  it("a duplicate is still a success", async () => {
    await joinWaitlist(idle, form({ email: "a@b.co" }));
    expect((await joinWaitlist(idle, form({ email: "a@b.co" }))).status).toBe("ok");
  });
  it("rejects an invalid email", async () => {
    const r = await joinWaitlist(idle, form({ email: "nope" }));
    expect(r.status).toBe("error");
    expect(join).not.toHaveBeenCalled();
  });
  it("pretends success for the honeypot", async () => {
    expect((await joinWaitlist(idle, form({ email: "a@b.co", company: "Acme" }))).status).toBe("ok");
    expect(join).not.toHaveBeenCalled();
  });
  it("limits to 5 a minute per IP", async () => {
    for (let i = 0; i < 5; i++) expect((await joinWaitlist(idle, form({ email: `a${i}@b.co` }))).status).toBe("ok");
    const r = await joinWaitlist(idle, form({ email: "z@b.co" }));
    expect(r.status).toBe("error");
    expect(join).toHaveBeenCalledTimes(5);
  });
  it("shows a plain error when storage fails", async () => {
    join.mockRejectedValue(new Error("not configured"));
    const r = await joinWaitlist(idle, form({ email: "a@b.co" }));
    expect(r).toEqual({ status: "error", message: expect.stringContaining("couldn't save") });
  });
});
