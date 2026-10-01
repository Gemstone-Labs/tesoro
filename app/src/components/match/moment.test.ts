import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { momentStorageKey, scheduleMoment, type MomentStore } from "./moment";

const memory = (): MomentStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("scheduleMoment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("still shows under StrictMode's mount, cleanup, mount", () => {
    const store = memory();
    const show = vi.fn();
    const cancel = scheduleMoment("42", store, show);
    cancel();
    scheduleMoment("42", store, show);
    vi.runAllTimers();
    expect(show).toHaveBeenCalledTimes(1);
    expect(store.data.get(momentStorageKey("42"))).toBe("1");
  });

  it("is not marked seen when the page is left before it shows", () => {
    const store = memory();
    const cancel = scheduleMoment("42", store, vi.fn());
    cancel();
    vi.runAllTimers();
    expect(store.data.size).toBe(0);
  });

  it("shows once per Match per tab", () => {
    const store = memory();
    const show = vi.fn();
    scheduleMoment("42", store, show);
    vi.runAllTimers();
    scheduleMoment("42", store, show);
    vi.runAllTimers();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("shows without storage", () => {
    const show = vi.fn();
    scheduleMoment("42", null, show);
    vi.runAllTimers();
    expect(show).toHaveBeenCalledTimes(1);
  });
});
