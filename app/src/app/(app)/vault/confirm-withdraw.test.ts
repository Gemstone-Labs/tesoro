import { beforeEach, describe, expect, it, vi } from "vitest";
import { withdrawAndConfirm } from "./confirm-withdraw";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), withdrawDeposit: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ toast: mocks.toast }));
vi.mock("@/lib/deposit/vault-actions", () => ({ withdrawDeposit: mocks.withdrawDeposit }));

const args = [{}, async () => null, { positions: [] }, "pos1"] as never;

beforeEach(() => { mocks.toast.mockReset(); mocks.withdrawDeposit.mockReset(); });

describe("withdrawAndConfirm", () => {
  it("toasts once the withdrawal went through", async () => {
    mocks.withdrawDeposit.mockResolvedValue("sig");
    await withdrawAndConfirm("Deposit 1", ...(args as [never, never, never, never]));
    expect(mocks.toast).toHaveBeenCalledWith("Deposit 1 withdrawn. Your SOL is back in your wallet.");
  });
  it("does not toast when the withdrawal fails", async () => {
    mocks.withdrawDeposit.mockRejectedValue(new Error("nope"));
    await expect(withdrawAndConfirm("Deposit 1", ...(args as [never, never, never, never]))).rejects.toThrow("nope");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
