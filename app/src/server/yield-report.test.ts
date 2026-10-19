import { describe, expect, it } from "vitest";
import { REPORT_COOLDOWN_MS, createYieldReporter } from "./yield-report";
import { DemoHttpError } from "./request-auth";

const V = "0x" + "a".repeat(40);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: DemoHttpError) => e.code);

function setup(over: { position?: { unlocked: boolean } | null; seq?: bigint; sendFails?: boolean; wrongChain?: boolean } = {}) {
  let t = 1_000_000;
  const state = { seq: over.seq ?? 0n };
  const sent: { id: bigint; value: bigint }[] = [];
  const report = createYieldReporter({
    requireChain: async () => {
      if (over.wrongChain) throw new DemoHttpError(503, "wrong-cluster", "x");
    },
    vaultPosition: async () => (over.position === undefined ? { unlocked: false } : over.position),
    lastYieldSeq: async () => state.seq,
    fee: async () => 120n,
    send: async (_v, id, value) => {
      if (over.sendFails) throw new Error("rpc down");
      sent.push({ id, value });
      return "0xhash";
    },
    now: () => t,
  });
  return { report, sent, state, advance: (ms: number) => (t += ms) };
}

describe("report-yield relay step", () => {
  it("sends the quoted fee and returns the hash", async () => {
    const s = setup();
    expect(await s.report(V, 3n)).toEqual({ hash: "0xhash" });
    expect(s.sent).toEqual([{ id: 3n, value: 120n }]);
  });

  it("refuses an unknown or unlocked Lock and the wrong chain", async () => {
    expect(await code(setup({ position: null }).report(V, 1n))).toBe("no-lock");
    expect(await code(setup({ position: { unlocked: true } }).report(V, 1n))).toBe("unlocked");
    expect(await code(setup({ wrongChain: true }).report(V, 1n))).toBe("wrong-cluster");
  });

  it("refuses a second request within the cooldown while the first has not landed", async () => {
    const s = setup();
    await s.report(V, 1n);
    s.advance(10_000);
    expect(await code(s.report(V, 1n))).toBe("report-pending");
    expect(s.sent).toHaveLength(1);
    expect(await code(s.report(V, 2n))).toBe("ok");
  });

  it("allows another after the cooldown, or once a report has landed", async () => {
    const s = setup();
    await s.report(V, 1n);
    s.advance(REPORT_COOLDOWN_MS);
    expect(await code(s.report(V, 1n))).toBe("ok");
    s.advance(5_000);
    s.state.seq = 4n;
    expect(await code(s.report(V, 1n))).toBe("ok");
    expect(s.sent).toHaveLength(3);
  });

  it("does not hold the cooldown after a failed send", async () => {
    const s = setup({ sendFails: true });
    await expect(s.report(V, 1n)).rejects.toThrow("rpc down");
    await expect(s.report(V, 1n)).rejects.toThrow("rpc down");
  });
});
