import { describe, expect, it } from "vitest";
import { TeeUnreachableError } from "../../lib/chain/tee-auth";
import { StepRetry, STEP_TROUBLE } from "./step-retry";

describe("a page's ride steps retry with backoff and say so when they keep failing", () => {
  it("backs off 1 s, 2 s, 4 s ... capped, and a success clears it", () => {
    const r = new StepRetry();
    expect(r.ready("start-ride:3", 0)).toBe(true);
    r.failed("start-ride:3", new Error("tee tx failed"), 0);
    expect(r.ready("start-ride:3", 999)).toBe(false);
    expect(r.ready("start-ride:3", 1_000)).toBe(true);
    r.failed("start-ride:3", new Error("x"), 1_000);
    expect(r.ready("start-ride:3", 2_999)).toBe(false);
    expect(r.ready("start-ride:3", 3_000)).toBe(true);
    for (let i = 0, t = 3_000; i < 10; i++, t += 20_000) r.failed("start-ride:3", new Error("x"), t);
    expect(r.ready("start-ride:3", 3_000 + 9 * 20_000 + 14_999)).toBe(false);
    expect(r.ready("start-ride:3", 3_000 + 9 * 20_000 + 15_000)).toBe(true);
    r.succeeded("start-ride:3", 400_000);
    expect(r.ready("start-ride:3", 400_000)).toBe(true);
  });

  it("is silent for the first failures (another page may have sent the step first) and speaks after three", () => {
    const r = new StepRetry();
    r.failed("finalize:3", new Error("x"), 0);
    r.failed("finalize:3", new Error("x"), 1_000);
    expect(r.trouble("finalize:3")).toBeNull();
    r.failed("finalize:3", new Error("x"), 3_000);
    expect(r.trouble("finalize:3")).toBe(STEP_TROUBLE);
    r.succeeded("finalize:3", 8_000);
    expect(r.trouble("finalize:3")).toBeNull();
  });

  it("waits out the game server's own pause (ban or rate limit) without counting it or hammering", () => {
    const r = new StepRetry();
    r.failed("signal:3", new TeeUnreachableError(60_000), 0);
    expect(r.ready("signal:3", 59_999)).toBe(false);
    expect(r.ready("signal:3", 60_000)).toBe(true);
    expect(r.trouble("signal:3")).toBe("Can’t reach the game server right now. Wait a minute and try again.");
  });

  it("keeps a commit at least 15 s apart even when it succeeds", () => {
    const r = new StepRetry();
    r.succeeded("commit:3", 0);
    expect(r.ready("commit:3", 14_999)).toBe(false);
    expect(r.ready("commit:3", 15_000)).toBe(true);
    expect(r.ready("depart:3", 1)).toBe(true);
  });
});
