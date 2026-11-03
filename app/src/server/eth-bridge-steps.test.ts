import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { STEPS } = await import("./eth-bridge");

describe("the relay route no longer sends bridge steps on its own", () => {
  it("has no step that applies a Lock or a Yield Report or sends a LayerZero message", () => {
    for (const step of ["apply-locked", "apply-yield", "send-unlock", "send-pay-yield", "send-pay-instant"]) expect(STEPS).not.toContain(step);
  });
  it("keeps what no Player transaction can carry, and the quote a Player's page builds its steps with", () => {
    expect(STEPS).toEqual(expect.arrayContaining(["init-position", "report-yield", "send-quote", "advance"]));
  });
});
