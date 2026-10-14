import { describe, expect, it } from "vitest";
import { createSimFaucet } from "./sim-faucet";
import type { DemoHttpError } from "./request-auth";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const TOKEN = "0x" + "c".repeat(40);

function setup(over: { at?: number; sendFails?: boolean; wrongChain?: boolean; maxPerHour?: number } = {}) {
  const sent: [string, string, string][] = [];
  const claim = createSimFaucet({
    requireChain: async () => {
      if (over.wrongChain) throw Object.assign(new Error("x"), { code: "wrong-cluster" });
    },
    availableAt: async () => over.at ?? 0,
    send: async (token, to, net) => {
      if (over.sendFails) throw new Error("rpc down");
      sent.push([token, to, net]);
      return "0xhash";
    },
    maxPerHour: over.maxPerHour,
    now: () => 1_000_000,
  });
  return { claim, sent };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: DemoHttpError) => e.code);

describe("sim faucet guards", () => {
  it("claims for a valid address", async () => {
    const t = setup();
    expect(await t.claim("w1", A, TOKEN, "hoodi", null)).toEqual({ hash: "0xhash" });
    expect(t.sent).toEqual([[TOKEN, A, "hoodi"]]);
  });

  it("rejects a malformed address and the wrong chain before sending", async () => {
    const t = setup({ wrongChain: true });
    expect(await code(t.claim("w1", "nope", TOKEN, "hoodi", null))).toBe("bad-request");
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("wrong-cluster");
    expect(t.sent).toHaveLength(0);
  });

  it("does not pay gas for a claim the contract would reject", async () => {
    const t = setup({ at: 1_000_000 });
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("cooldown");
    expect(t.sent).toHaveLength(0);
  });

  it("one claim per hour per wallet and net, and a global cap", async () => {
    const t = setup({ maxPerHour: 2 });
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("ok");
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("rate-limited");
    expect(await code(t.claim("w1", A, TOKEN, "hyperevm", null))).toBe("ok");
    expect(await code(t.claim("w2", B, TOKEN, "hoodi", null))).toBe("rate-limited");
  });

  it("gives the allowance back when the send fails", async () => {
    const t = setup({ sendFails: true });
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("chain");
    expect(await code(t.claim("w1", A, TOKEN, "hoodi", null))).toBe("chain");
  });
});
