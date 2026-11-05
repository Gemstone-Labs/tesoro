import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { storedWorkedRide } from "@/games/railcar/fixtures";
import { winCardFromRow } from "@/lib/win-card";

vi.mock("server-only", () => ({}));
const { winCard } = await import("./spot-card");

describe("the share card of a Railcar ride", () => {
  it("renders through next/og as the 1200x630 PNG the /win route serves", { timeout: 60_000 }, async () => {
    const ride = storedWorkedRide({ brake: true });
    const win = winCardFromRow({ id: ride.id, game: "railcar", entry: 500, winner: ride.ride.places[0].player, gemas: 313, ride: ride.ride }, { name: "Dee", avatar: { kind: "animal", index: 4 } })!;
    const png = Buffer.from(await (await winCard(win)).arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    // CARD_OUT=<file>: keep the image (for screenshots).
    if (process.env.CARD_OUT) writeFileSync(process.env.CARD_OUT, png);
  });
});
