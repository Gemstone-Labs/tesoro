import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ride } from "./engine";
import { ANA, DEE, drawWithCrash, storedWorkedRide } from "./fixtures";
import { RideHistory } from "./RideHistory";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

describe("a finished ride's page", () => {
  it("shows the result as the Player saw it, then the bomb, the warnings and the draw, and says the replay matches", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide()} me={DEE.toBase58()} />));
    expect(t).toContain("Last off");
    expect(t).toContain("You get 203");
    const d = ride(drawWithCrash(30_000));
    expect(t).toContain("Bomb time 0:30");
    expect(t).toContain(`Glow ${secs(d.screwLeadMs)} before the bomb`);
    expect(t).toContain(`Hot seams ${secs(d.boltLeadMs!)} before the bomb`);
    expect(t).toContain(`White-hot ${secs(d.sparkLeadMs!)} before the bomb`);
    expect(t).not.toContain("Did not show");
    expect(t).toContain("Nobody braked");
    expect(t).toContain(storedWorkedRide().ride.draw!.slice(0, 16));
    expect(t).toContain("Replayed with the published rules: every refund and place matches what was paid.");
  });

  it("a Tell the ride did not show says so, and the replay still matches (decisions Q39)", () => {
    const sparkless = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ shows: { sparks: false } })} me={null} />));
    expect(sparkless).toMatch(/Hot seams [\d.]+ s before the bomb/);
    expect(sparkless).toContain("White-hot Did not show");
    expect(sparkless).toContain("Replayed with the published rules: every refund and place matches what was paid.");
    const screwsOnly = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ shows: { panel: false, sparks: false } })} me={null} />));
    expect(screwsOnly).toMatch(/Glow [\d.]+ s before the bomb/);
    expect(screwsOnly).toContain("Hot seams Did not show");
    expect(screwsOnly).toContain("White-hot Did not show");
  });

  it("a Brake: when it was pressed, and where the bomb then went off on the clock", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ brake: true })} me={null} />));
    expect(t).toContain("Bomb time 0:30");
    expect(t).toContain("Blast on the clock 0:32");
    expect(t).toMatch(/Braked at 0:20/);
    // A spectator: no "You get", the headline is the ride's.
    expect(t).not.toContain("You get");
    expect(t).toContain("Ride over");
  });

  it("a record the replay does not give is shown as a difference", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ tamper: true })} me={ANA.toBase58()} />));
    expect(t).toContain("The replay differs from what was paid");
    expect(t).toContain("Seat 1 was refunded 40, the replay gives 0.");
  });

  it("a car refunded before its ride was revealed says so, with no ride to check", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={{ id: "Opener1-7", entry: 100, ride: null, refunded: true }} me={ANA.toBase58()} />));
    expect(t).toContain("This car was refunded before its ride was revealed, so there is no ride to check. Every entry went back to whoever paid it.");
    expect(t).not.toContain("not a Railcar ride");
    expect(t).not.toContain("Bomb time");
  });
});
