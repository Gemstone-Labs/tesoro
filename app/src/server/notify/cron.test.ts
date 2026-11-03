import { describe, expect, it, vi } from "vitest";
import { runDigestCron, runNotifyCron } from "./cron";

const passes = () => ({ pending: vi.fn(async () => ({ processed: 2, failed: 0 })), delayed: vi.fn(async () => ({ told: 1 })) });

describe("the notify cron", () => {
  it("refuses a missing or wrong secret and runs nothing", async () => {
    const p = passes();
    await expect(runNotifyCron(p, "s3cret", null)).rejects.toMatchObject({ status: 401 });
    await expect(runNotifyCron(p, "s3cret", "Bearer nope")).rejects.toMatchObject({ status: 401 });
    expect(p.pending).not.toHaveBeenCalled();
    expect(p.delayed).not.toHaveBeenCalled();
  });

  it("is not configured without a secret", async () => {
    await expect(runNotifyCron(passes(), undefined, "Bearer x")).rejects.toMatchObject({ status: 503 });
  });

  it("runs the stored-transaction emails, then the Delayed check, and reports both", async () => {
    const p = passes();
    expect(await runNotifyCron(p, "s3cret", "Bearer s3cret")).toEqual({ processed: 2, failed: 0, delayed: 1 });
    expect(p.pending.mock.invocationCallOrder[0]).toBeLessThan(p.delayed.mock.invocationCallOrder[0]);
  });

  it("still checks Delayed Matches when the stored transactions fail", async () => {
    const p = passes();
    p.pending.mockRejectedValue(new Error("db"));
    await expect(runNotifyCron(p, "s3cret", "Bearer s3cret")).rejects.toThrow("db");
    expect(p.delayed).toHaveBeenCalled();
  });
});

describe("the daily digest cron", () => {
  it("refuses a wrong secret, and sends the digests with the right one", async () => {
    const send = vi.fn(async () => ({ sent: 3, dropped: 0 }));
    await expect(runDigestCron(send, "s3cret", "Bearer nope")).rejects.toMatchObject({ status: 401 });
    await expect(runDigestCron(send, undefined, "Bearer s3cret")).rejects.toMatchObject({ status: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(await runDigestCron(send, "s3cret", "Bearer s3cret")).toEqual({ sent: 3, dropped: 0 });
  });
});
