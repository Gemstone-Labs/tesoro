import { describe, expect, it, vi } from "vitest";
import { COMMIT_SLOW_MS, MARKER_TTL_MS, commitPendingKey, commitPendingSince, setCommitPending, commitCopy, commitPhase, isCommitPending } from "./commit-pending";

describe("commit pending", () => {
  it("recognises the delegation-owned refusal", () => {
    expect(isCommitPending(new Error("custom program error: 0xbbf"))).toBe(true);
    expect(isCommitPending(new Error("Error Code: AccountOwnedByWrongProgram. Error Number: 3007."))).toBe(true);
    expect(isCommitPending(new Error("blockhash not found"))).toBe(false);
    expect(isCommitPending("Error Number: 30070")).toBe(false);
  });

  it("turns slow after two minutes", () => {
    expect(commitPhase(1000, 1000 + COMMIT_SLOW_MS - 1)).toBe("sending");
    expect(commitPhase(1000, 1000 + COMMIT_SLOW_MS)).toBe("slow");
  });

  it("words winners and losers differently once slow", () => {
    expect(commitCopy({ phase: "sending", won: false }).line).toBe("Sending it to the chain…");
    expect(commitCopy({ phase: "slow", won: true }).line).toMatch(/winnings show in your Vault/);
    expect(commitCopy({ phase: "slow", won: false }).line).not.toMatch(/winnings/);
  });

  it("expires the Home marker after 48 hours", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    setCommitPending(7n, true, 1000);
    expect(commitPendingKey(1000 + MARKER_TTL_MS - 1)).toBe("7");
    expect(commitPendingSince(7n, 2000)).toBe(1000);
    expect(commitPendingKey(1000 + MARKER_TTL_MS)).toBe("");
    setCommitPending(7n, false, 2000);
    expect(commitPendingKey(2000)).toBe("");
    vi.unstubAllGlobals();
  });
});
