import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAYERS, boardingCountdown, boardingNotAboard, boardingWaiting, nobodyJumped, rideStarting, riding, workedResult, ANA, EVE } from "./fixtures";
import { RailcarScreen } from "./RailcarScreen";
import type { RailcarView } from "./view";

const html = (view: RailcarView, brake: { left: number; activeMs: number } | null = null) => renderToStaticMarkup(<RailcarScreen view={view} brake={brake} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Boarding", () => {
  it("below 5: waiting, how many aboard, my seat, Step off with the full entry back", () => {
    const t = text(html(boardingWaiting()));
    expect(t).toContain("Waiting for 5 Players");
    expect(t).toContain("3 aboard of 100 seats");
    expect(t).toContain("Your seat 3");
    expect(t).toContain("Step off");
    expect(t).toMatch(/Full .*500 back/);
    expect(t).not.toContain("Jump");
  });

  it("from the 5th: the countdown", () => {
    const t = text(html(boardingCountdown()));
    expect(t).toContain("Leaves in");
    expect(t).toContain("0:21");
    expect(t).toContain("Your seat 14");
  });

  it("a Player who has not boarded gets Board instead of Step off", () => {
    const t = text(html(boardingNotAboard()));
    expect(t).toContain("Board");
    expect(t).not.toContain("Step off");
  });
});

describe("the Ride, in the same screen", () => {
  it("Boarding and the Ride share one stage: the layout turns into the Ride without another page", () => {
    // Same section, same stage element in the same place: only the panels around it change.
    for (const v of [boardingCountdown(PLAYERS[0]), rideStarting()]) {
      const h = html(v);
      expect(h.match(/<section class="rc (boarding|riding)"/g)).toHaveLength(1);
      expect(h.match(/class="rc-stage[ "]/g)).toHaveLength(1);
    }
    expect(html(rideStarting())).toContain('class="rc-stage moving"');
    expect(html(boardingCountdown())).not.toContain("rc-stage moving");
  });

  it("shows the clock, the Tells, who is aboard, the Gemas at stake and Jump; never speed, distance or a refund percentage", () => {
    const t = text(html(riding()));
    expect(t).toContain("1:12");
    expect(t).toMatch(/Screws.*Panel.*Sparks/);
    expect(t).toContain("Aboard 29");
    expect(t).toContain("At stake");
    expect(t).toContain("20,000");
    expect(t).toContain("Jump");
    expect(t).not.toMatch(/%|km|speed|distance/i);
  });

  it("after my Jump: what I got back, and I keep watching", () => {
    const t = text(html(riding(PLAYERS[0], { jumpedMe: true })));
    expect(t).toContain("You jumped at 0:25");
    expect(t).toContain("350");
    expect(t).not.toMatch(/>\s*Jump\s*</);
  });

  it("the Brake tag shows only while I am aboard", () => {
    expect(text(html(riding(), { left: 0, activeMs: 3_200 }))).toContain("only you see this");
    expect(text(html(riding(PLAYERS[0], { jumpedMe: true }), { left: 0, activeMs: 3_200 }))).not.toContain("only you see this");
    expect(text(html(riding(null), { left: 0, activeMs: 3_200 }))).not.toContain("only you see this");
  });
});

describe("the Result", () => {
  it("the worked example: 813 / 630 / 578 / 350 / 0, fees 129, the wall at 1:44", () => {
    const t = text(html(workedResult()));
    expect(t).toContain("Last off");
    expect(t).toMatch(/You get .*813/);
    expect(t.indexOf("813")).toBeLessThan(t.indexOf("630"));
    expect(t.indexOf("630")).toBeLessThan(t.indexOf("578"));
    expect(t).toMatch(/jumped early .*350/);
    expect(t).toMatch(/aboard .*0/);
    expect(t).toMatch(/Fees .*129/);
    expect(t).toContain("Wall 1:44");
    expect(t).toContain("Play again");
    expect(t).toContain("Share");
  });

  it("the early jumper and the Player left aboard read their own headline", () => {
    expect(text(html(workedResult(ANA)))).toContain("Jumped early");
    expect(text(html(workedResult(EVE)))).toContain("Aboard at Impact");
  });

  it("nobody jumped: every entry back and no fees line", () => {
    const t = text(html(nobodyJumped()));
    expect(t).toContain("Nobody jumped");
    expect(t).not.toContain("Fees");
  });
});
