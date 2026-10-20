import { describe, expect, it, vi } from "vitest";
import { onGetGemas, requestGetGemas } from "./get-gemas";

describe("get Gemas request", () => {
  it("reaches every listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onGetGemas(a);
    const offB = onGetGemas(b);
    requestGetGemas();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("stops after unsubscribe", () => {
    const cb = vi.fn();
    const off = onGetGemas(cb);
    off();
    requestGetGemas();
    expect(cb).not.toHaveBeenCalled();
  });
});
