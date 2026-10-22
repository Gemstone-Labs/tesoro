import { describe, expect, it, vi } from "vitest";
import { confirmThenPay } from "./confirm-ack";

const setup = (dontShowAgain: boolean, confirm: () => Promise<void> = async () => undefined) => {
  const calls: string[] = [];
  const o = {
    confirm: vi.fn(async () => {
      calls.push("confirm");
      await confirm();
    }),
    dontShowAgain,
    rememberDontShow: vi.fn(() => void calls.push("remember")),
    pay: vi.fn(() => void calls.push("pay")),
  };
  return { o, calls };
};

describe("confirmThenPay", () => {
  it("records consent before the deposit goes on", async () => {
    const { o, calls } = setup(false);
    expect(await confirmThenPay(o)).toBeNull();
    expect(calls).toEqual(["confirm", "pay"]);
    expect(o.rememberDontShow).not.toHaveBeenCalled();
  });

  it("remembers Don't show this again only after consent is recorded", async () => {
    const { o, calls } = setup(true);
    await confirmThenPay(o);
    expect(calls).toEqual(["confirm", "remember", "pay"]);
  });

  it("stops when the server refuses: no deposit, nothing remembered", async () => {
    const { o } = setup(true, async () => {
      throw new Error("down");
    });
    const out = await confirmThenPay(o);
    expect(out?.error).toBeInstanceOf(Error);
    expect(o.pay).not.toHaveBeenCalled();
    expect(o.rememberDontShow).not.toHaveBeenCalled();
  });
});
