import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ride } from "./engine";
import { ANA, DEE, drawWithCrash, storedWorkedRide } from "./fixtures";
import { RideHistory } from "./RideHistory";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

describe("a finished ride's page", () => {
  it("shows the result as the Player saw it, then the wall, the Tells and the draw, and says the replay matches", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide()} me={DEE.toBase58()} />));
    expect(t).toContain("Last off");
    expect(t).toContain("You get 813");
    const d = ride(drawWithCrash(104_000));
    expect(t).toContain("Crash point 1:44");
    expect(t).toContain(`Screws ${secs(d.screwLeadMs)} before the wall`);
    expect(t).toContain(`Panel ${secs(d.boltLeadMs!)} before the wall`);
    expect(t).toContain(`Sparks ${secs(d.sparkLeadMs!)} before the wall`);
    expect(t).not.toContain("Did not show");
    expect(t).toContain("Nobody braked");
    expect(t).toContain(storedWorkedRide().ride.draw!.slice(0, 16));
    expect(t).toContain("Replayed with the published rules: every refund and place matches what was paid.");
  });

  it("a Tell the ride did not show says so, and the replay still matches (decisions Q39)", () => {
    const sparkless = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ shows: { sparks: false } })} me={null} />));
    expect(sparkless).toMatch(/Panel [\d.]+ s before the wall/);
    expect(sparkless).toContain("Sparks Did not show");
    expect(sparkless).toContain("Replayed with the published rules: every refund and place matches what was paid.");
    const screwsOnly = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ shows: { panel: false, sparks: false } })} me={null} />));
    expect(screwsOnly).toMatch(/Screws [\d.]+ s before the wall/);
    expect(screwsOnly).toContain("Panel Did not show");
    expect(screwsOnly).toContain("Sparks Did not show");
  });

  it("a Brake: when it was pressed, and where the wall then came on the clock", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ brake: true })} me={null} />));
    expect(t).toContain("Crash point 1:44");
    expect(t).toContain("Impact on the clock 1:46");
    expect(t).toMatch(/Braked at 1:30/);
    // A spectator: no "You get", the headline is the ride's.
    expect(t).not.toContain("You get");
    expect(t).toContain("Ride over");
  });

  it("a record the replay does not give is shown as a difference", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={storedWorkedRide({ tamper: true })} me={ANA.toBase58()} />));
    expect(t).toContain("The replay differs from what was paid");
    expect(t).toContain("Seat 1 was refunded 400, the replay gives 350.");
  });

  it("a car refunded before its ride was revealed says so, with no ride to check", () => {
    const t = text(renderToStaticMarkup(<RideHistory page={{ id: "Opener1-7", entry: 500, ride: null, refunded: true }} me={ANA.toBase58()} />));
    expect(t).toContain("This car was refunded before its ride was revealed, so there is no ride to check. Every entry went back to whoever paid it.");
    expect(t).not.toContain("not a Railcar ride");
    expect(t).not.toContain("Crash point");
  });
});
