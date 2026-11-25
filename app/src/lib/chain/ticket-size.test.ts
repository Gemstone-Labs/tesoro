import { describe, expect, it } from "vitest";
import { MAX_INITIAL_TICKET_LINES, potLen } from "./entry";

describe("the size of a Ticket the page opens", () => {
  // core: ticket.rs `MAX_INITIAL_TICKET_LINES = (10_240 - POT_AT - 128) / LINE_LEN`, POT_AT = 8 + 192 since Ticket v2. The page used the
  // old 160-byte head and asked for 69 lines, which open_ticket refuses (GrowTooLarge).
  it("matches core's limit and fits one account creation", () => {
    expect(MAX_INITIAL_TICKET_LINES).toBe(68);
    expect(potLen(MAX_INITIAL_TICKET_LINES)).toBeLessThanOrEqual(10_240);
    expect(potLen(MAX_INITIAL_TICKET_LINES + 1)).toBeGreaterThan(10_240);
  });
});
