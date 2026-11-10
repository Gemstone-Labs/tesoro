import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAYERS, DELAYED_REFUND_AT, boardingCountdown, boardingNotAboard, boardingWaiting, nobodyJumped, rideDelayed, rideStarting, riding, workedResult, ANA, BEN, BOB, EVE } from "./fixtures";
import { brakeState, type BrakeFacts } from "./brake";
import { RailcarScreen, type RailcarBrake } from "./RailcarScreen";
import type { RailcarView } from "./view";
import { refundByText } from "@/lib/chain/match-status";

const html = (view: RailcarView, brake: RailcarBrake | null = null) => renderToStaticMarkup(<RailcarScreen view={view} brake={brake} />);
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

describe("staging round 1: what the screen no longer says", () => {
  it("Boarding has no countdown hint, no ABOARD label above the riders and no step-off line before boarding", () => {
    const t = text(html(boardingWaiting(null)));
    expect(t).toContain("Waiting for 5 Players");
    expect(t).not.toContain("The countdown starts");
    expect(t).not.toMatch(/\bAboard\b/);
    expect(t).not.toContain("Until it leaves you can step off");
    expect(text(html(boardingNotAboard()))).not.toContain("Until it leaves you can step off");
    expect(text(html(boardingNotAboard()))).not.toMatch(/\bAboard\b/);
    expect(text(html(boardingWaiting()))).not.toMatch(/\bAboard\b[^a-z]/);
  });

  it("the ride keeps its count and At stake, but not 'Names leave when they Jump'", () => {
    const t = text(html(riding()));
    expect(t).toContain("Aboard 29");
    expect(t).toContain("At stake");
    expect(t).not.toContain("Names leave");
  });

  it("Practice shows no At stake row", () => {
    const t = text(renderToStaticMarkup(<RailcarScreen view={riding()} practice />));
    expect(t).not.toContain("At stake");
  });

  it("the Result rows are all the same width: no indent on places 2 and 3", () => {
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.rc-plate\.p[23][^}]*margin/);
  });

  it("every avatar frame (riders, places, Jumped rows) is a regular octagon: the cut is 29% of the side", () => {
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.rc-av \{ --c: 14px;/);
    expect(css).toMatch(/\.rc-av\.sm \{ --c: 9px;/);
    expect(css).toMatch(/\.rc-leap img \{[^}]*clip-path: polygon\(29% 0, 71% 0, 100% 29%/);
  });
});

describe("the active Brake outline", () => {
  it("is the cut edge (--edge), not a rectangular shadow the clip-path would cut off", () => {
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.rc-brake\.on \.btn \{ --edge: var\(--edge-em\)/);
    expect(css).not.toMatch(/\.rc-brake[^{]*\{[^}]*box-shadow/);
  });
});

describe("my secret Brake", () => {
  const facts: BrakeFacts = { aboard: true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: null, pending: false, rideMs: 72_000 };
  const button = (h: string) => text(h.match(/<div class="rc-brake[^"]*">.*?<\/div>/)?.[0] ?? "");
  const disabled = (h: string) => /<div class="rc-brake[^"]*"><button[^>]*disabled/.test(h);

  it("the button reads my Brake: ready, riding on the next tick, my 5 s, used, or waiting for the seats", () => {
    const at = (o: Partial<BrakeFacts>) => html(riding(), brakeState({ ...facts, ...o }));
    expect(button(at({}))).toContain("Brake 5s");
    expect(disabled(at({}))).toBe(false);
    expect(button(at({ pending: true }))).toContain("Brake sending");
    expect(button(at({ pressMs: 69_000 }))).toContain("Brake 2s");
    expect(button(at({ pressMs: 60_000 }))).toContain("Brake used");
    expect(button(at({ allBound: false }))).toContain("Brake soon");
    for (const o of [{ pending: true }, { pressMs: 69_000 }, { pressMs: 60_000 }, { allBound: false }]) expect(disabled(at(o))).toBe(true);
  });

  it("on the wallet route, until my wallet signed once this ride, the button asks for that and says why in plain words", () => {
    const h = html(riding(), brakeState({ ...facts, walletCopied: false }));
    expect(button(h)).toContain("Brake sign first");
    expect(disabled(h)).toBe(false);
    expect(text(h)).toContain("Sign once so your Brake stays secret on this device");
    expect(text(html(riding(), brakeState(facts)))).not.toContain("Sign once");
  });

  it("while my Brake runs, only my screen slows the stage and shows the tag; another Player's screen is the same as before", () => {
    const mine = html(riding(PLAYERS[0]), brakeState({ ...facts, pressMs: 69_000 }));
    expect(mine).toContain("rc-stage moving slow");
    expect(text(mine)).toContain("only you see this");
    // Ben's page: his own Brake untouched, the same public Table, before and after Ana's Brake
    const ben = () => html(riding(PLAYERS[1]), brakeState(facts));
    expect(ben()).toBe(ben());
    expect(ben()).not.toContain("only you see this");
    expect(ben()).not.toContain("slow");
  });

  it("a spectator and a Player who Jumped get no Brake", () => {
    expect(brakeState({ ...facts, aboard: false })).toBeNull();
    expect(html(riding(null), null)).not.toContain("rc-brake");
  });

  it("after my Jump: at least what comes back", () => {
    expect(text(html(riding(PLAYERS[0], { jumpedMe: true })))).toMatch(/You jumped at 0:25 · at least 350 Gemas back/);
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

describe("Spectators", () => {
  const watch = (signedIn: boolean, nextSeated: number | null = 12) => renderToStaticMarkup(<RailcarScreen view={riding(null)} watch={{ signedIn, nextSeated }} actions={{ onBoard: () => undefined, onSignIn: () => undefined }} />);

  it("watch the live ride as a Player who has not Braked: clock, Tells, aboard, at stake; no Jump, no Brake", () => {
    const h = watch(false);
    const t = text(h);
    expect(t).toContain("Live");
    expect(t).toContain("1:12");
    expect(t).toContain("Aboard 29");
    expect(t).toContain("At stake");
    expect(h).not.toMatch(/<button[^>]*>(Jump|Brake)/);
  });

  it("are offered the next ride, with how many have boarded it", () => {
    const t = text(watch(true));
    expect(t).toContain("Play the next ride");
    expect(t).toContain("Boarding next: 12 aboard");
    expect(text(watch(true, null))).toContain("Boarding next: no car yet, you open it");
  });

  it("signed out: the same button signs in first", () => {
    const t = text(watch(false));
    expect(t).toContain("Play the next ride");
    expect(t).toContain("Sign in to board");
  });

  it("the Result of the ride they watched: the ride's headline and the next ride", () => {
    const t = text(renderToStaticMarkup(<RailcarScreen view={workedResult(null)} watch={{ signedIn: true, nextSeated: 3 }} actions={{ onBoard: () => undefined }} />));
    expect(t).toContain("Ride over");
    expect(t).toContain("Play the next ride");
    expect(t).not.toContain("Play again");
  });
});

describe("Backing: a Player boards with a Backer's Gemas", () => {
  const offer = { backer: BOB.toBase58(), sharePct: 40 };
  const backed = { seat: 1, backer: BOB, shareBps: 4_000 };
  const board = (o = offer) => renderToStaticMarkup(<RailcarScreen view={boardingCountdown(null)} offer={o} actions={{ onBoard: () => undefined }} />);

  it("before boarding: whose Gemas board, the Player's share, and a step-off that goes back to the Backer", () => {
    const t = text(board());
    expect(t).toContain("funds your entry");
    expect(t).toMatch(/Their .*500 board for you\. Place and you keep 40% of the winnings; you never owe anything\./);
    expect(t).toContain("the full entry goes back to your Backer");
  });

  it("the Backer already in this car: Board waits and says why", () => {
    const h = board({ ...offer, blocked: "Your Backer is in this car: board the next one" } as typeof offer);
    expect(text(h)).toContain("Your Backer is in this car: board the next one");
    expect(h).toMatch(/<button[^>]*disabled[^>]*>[^<]*Board/);
  });

  it("aboard with the Backer's Gemas: Step off sends the full 500 back to them", () => {
    expect(text(html(boardingCountdown(BEN, backed)))).toMatch(/Full .*500 back to /);
  });

  it("the result as Ben: he gets 52, Bob 578 with his entry back first, and Ben's plate shows the split", () => {
    const t = text(html(workedResult(BEN, backed)));
    expect(t).toMatch(/You get .*52/);
    expect(t).toMatch(/gets .*578/);
    expect(t).toContain("entry comes back first");
    expect(t).toMatch(/578[^·]*· you[^·]*52/);
  });

  it("aboard at Impact backed: the Backer bears the loss", () => {
    expect(text(html(workedResult(EVE, { ...backed, seat: 4 })))).toContain("Your Backer bears the loss");
  });
});

describe("a ride that never started: Delayed instead of a clock stuck at 0:00", () => {
  it("a Player aboard: Delayed, the car stands still, no Jump or Brake, the refund time from the chain", () => {
    const h = html(rideDelayed(), { left: 1, activeMs: 0 });
    const t = text(h);
    expect(t).toContain("Delayed");
    expect(t).toContain(`Your entry is safe: if it has not started by ${refundByText(DELAYED_REFUND_AT, Date.now())}, it is refunded.`);
    expect(t).not.toMatch(/Jump|Brake/);
    expect(h).not.toContain('role="timer"');
    expect(h).toContain('class="rc-stage"');
  });

  it("a Spectator: no Live chip and no Play the next ride, which would wait behind this car", () => {
    const t = text(renderToStaticMarkup(<RailcarScreen view={rideDelayed(null)} watch={{ signedIn: true, nextSeated: 3 }} actions={{ onBoard: () => undefined }} />));
    expect(t).toContain("every entry is refunded");
    expect(t).not.toMatch(/Live|Play the next ride/);
  });

  it("once the refund time passed: the refund is open", () => {
    expect(text(html(rideDelayed(PLAYERS[0], true)))).toContain("Delayed, refund is open");
  });
});
