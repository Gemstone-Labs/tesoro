import { describe, expect, it } from "vitest";
import { ageGate } from "./age-gate";

describe("ageGate", () => {
  it("waits for the server while it has not answered", () => {
    expect(ageGate({ server: null, cached: false, checked: false })).toBe("checking");
  });
  it("asks a new Account and blocks the entry until confirmed", () => {
    expect(ageGate({ server: false, cached: false, checked: true })).toBe("ask");
  });
  it("lets a confirmed Account through", () => {
    expect(ageGate({ server: true, cached: false, checked: true })).toBe("go");
  });
  it("trusts this browser's memory of a confirmation", () => {
    expect(ageGate({ server: null, cached: true, checked: false })).toBe("go");
  });
  it("asks when the server could not be reached and nothing is remembered", () => {
    expect(ageGate({ server: null, cached: false, checked: true })).toBe("ask");
  });
});
