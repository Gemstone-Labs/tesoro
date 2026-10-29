import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastHost, toast } from "./Toast";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); });

describe("toast", () => {
  it("shows the message in a status region", () => {
    toast("Redeemed 5 Gemas");
    const html = renderToStaticMarkup(<ToastHost />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Redeemed 5 Gemas");
  });
  it("goes away by itself", () => {
    toast("Saved");
    vi.advanceTimersByTime(TOAST_MS + 1);
    expect(renderToStaticMarkup(<ToastHost />)).not.toContain("Saved");
  });
  it("keeps the newest three", () => {
    ["a1", "a2", "a3", "a4"].forEach(toast);
    const html = renderToStaticMarkup(<ToastHost />);
    expect(html).not.toContain("a1");
    expect(html).toContain("a4");
  });
});
