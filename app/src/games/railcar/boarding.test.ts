import { describe, expect, it, vi } from "vitest";
import { boardWithRetry, isStaleBoard } from "./boarding";

const stale = () => new Error("Transaction failed: custom program error: 0x7d6");

describe("boarding when another rider's open or join lands first", () => {
  it("knows the errors a stale snapshot causes: open_car's car address (ConstraintSeeds 0x7d6), a car still boarding (0x1775), a seat page that filled", () => {
    expect(isStaleBoard(stale())).toBe(true);
    expect(isStaleBoard(new Error("custom program error: 0x1775"))).toBe(true);
    expect(isStaleBoard(new Error("A car is still boarding: board it"))).toBe(true);
    expect(isStaleBoard(new Error("AnchorError caused by account: car. Error Code: ConstraintSeeds."))).toBe(true);
  });

  it("does not retry other errors: a declined prompt, an empty wallet, a Backer in the car", async () => {
    for (const e of [new Error("User rejected the request"), new Error("Not enough Gemas"), new Error("Your Backer is in this car: board the next one.")]) {
      const attempt = vi.fn().mockRejectedValue(e);
      await expect(boardWithRetry(attempt, { waitMs: () => 0 })).rejects.toBe(e);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it("rebuilds from fresh state and sends again once, and the second board is the join the first rider's open made possible", async () => {
    const seen: string[] = [];
    let carOpened = false;
    const attempt = vi.fn(async () => {
      const choice = carOpened ? "join" : "open";
      seen.push(choice);
      if (choice === "open") {
        carOpened = true; // rider 1's open lands between this rider's read and send
        throw stale();
      }
    });
    await boardWithRetry(attempt, { waitMs: () => 0 });
    expect(seen).toEqual(["open", "join"]);
  });

  it("is bounded: gives up with the last error after 3 attempts, waiting longer each time", async () => {
    const waits: number[] = [];
    const attempt = vi.fn().mockRejectedValue(stale());
    await expect(boardWithRetry(attempt, { waitMs: (n) => (waits.push(n), 0) })).rejects.toThrow("0x7d6");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1, 2]);
  });
});
