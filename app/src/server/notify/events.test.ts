import { describe, expect, it } from "vitest";
import { DAILY_LIMIT, decide, describe as say, type NotifyEvent, type NotifyPrefs } from "./decide";
import { handleDigest, handleEvents } from "./routes";
import { digestEmail } from "./digest";
import type { Email } from "./decide";
import type { EmailSender } from "./sender";
import { MemoryNotifyStore } from "./store";
import type { NotifyDeps } from "./service";
import { parseEvents } from "./events";

const A = "7zr1j185Zq3iDzVbQvQ6w4o8KJ5mQ2kE9yP3xGqh7MrT".slice(0, 44);
const B = "G7zDabcdefghijkmnopqrstuvwxyzABCDEFGH1234567".slice(0, 44);
const SECRET = "s";
const NOW = 1_800_000_000_000;
const prefs: NotifyPrefs = { email: "p@example.com", verified: true, enabled: true };

const events: NotifyEvent[] = [
  { kind: "opponent-played", id: "1", authority: A, matchId: "9", game: "block-puzzle" },
  { kind: "match-delayed", id: "2", authority: A, matchId: "9", game: "trading-duel", refundBy: 1_800_003_540, refundOpen: false },
  { kind: "match-refunded", id: "3", authority: A, matchId: "9", game: "holdem", entry: 500 },
  { kind: "offer-made", id: "4", authority: A, offerId: "o1", game: "block-puzzle", entry: 1000 },
  { kind: "offer-accepted", id: "5", authority: A, offerId: "o1", game: "block-puzzle", entry: 1000 },
  { kind: "debt-cleared", id: "6", authority: A, positionId: "p1", asset: "SOL" },
  { kind: "season-placed", id: "7", authority: A, season: 2, rank: 3, gemas: 1250 },
];

describe("who gets what for each event", () => {
  it("sends each event to its Player in plain words", () => {
    const subjects = events.map((e) => decide(e, prefs, 0).emails[0]);
    expect(subjects.map((m) => m.subject)).toEqual([
      "Your opponent has played your Block Puzzle Match",
      "Your Trading Duel Match is delayed",
      "Your Hold'em Match was refunded",
      "A Backer made you an Offer",
      "A Player accepted your Offer",
      "Your Advance is paid back",
      "You placed 3rd in Season 2",
    ]);
    expect(subjects.every((m) => m.to === "p@example.com")).toBe(true);
    expect(subjects[2].text).toContain("entry of 500 Gemas is back");
    expect(subjects[5].text).toContain("Unlock it or take another Advance");
    expect(subjects[6].text).toContain("won 1,250 Gemas from the Pool");
  });

  it("the Delayed email carries the refund deadline, or says the refund is open", () => {
    const wait = say(events[1]);
    expect(wait.body).toContain("refunded by Fri, Jan 15, 8:59 am UTC");
    const open = say({ ...(events[1] as Extract<NotifyEvent, { kind: "match-delayed" }>), refundOpen: true });
    expect(open.body).toContain("refund is open now");
    expect(open.body).not.toContain("UTC");
  });

  it("holds every kind for the digest past the day's limit, and sends nothing to an unverified address", () => {
    for (const e of events) {
      expect(decide(e, prefs, DAILY_LIMIT).digest).toHaveLength(1);
      expect(decide(e, { ...prefs, verified: false }, 0)).toMatchObject({ emails: [], skipped: "unverified" });
      expect(decide(e, null, 0)).toMatchObject({ emails: [], skipped: "no-address" });
    }
  });

  it("ranks read as 1st 2nd 3rd 4th 11th 21st", () => {
    const t = (rank: number) => say({ kind: "season-placed", id: "x", authority: A, season: 1, rank, gemas: 0 }).subject;
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(t)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st"].map((o) => `You placed ${o} in Season 1`));
  });
});

class FakeSender implements EmailSender {
  sent: Email[] = [];
  fail = false;
  async send(email: Email) {
    if (this.fail) throw new Error("down");
    this.sent.push(email);
  }
}
async function setup() {
  const store = new MemoryNotifyStore();
  const sender = new FakeSender();
  const deps: NotifyDeps = { store, sender, siteUrl: "https://t.example", now: () => NOW };
  await store.saveEmail(A, "p@example.com", "tok");
  await store.verify("tok");
  return { store, sender, deps };
}
const wire = (over: object = {}) => ({ kind: "match-refunded", authority: A, matchId: "5", game: "holdem", entry: 500, ...over });
const push = (deps: NotifyDeps, ...e: object[]) => handleEvents(deps, SECRET, `Bearer ${SECRET}`, { events: e });

describe("event push from the keeper", () => {
  it("sends each fact once, however often it is pushed", async () => {
    const { deps, sender } = await setup();
    expect((await push(deps, wire())).outcomes).toEqual(["sent"]);
    expect((await push(deps, wire(), wire())).outcomes).toEqual(["duplicate", "duplicate"]);
    expect(sender.sent).toHaveLength(1);
    expect((await push(deps, wire({ matchId: "6" }))).outcomes).toEqual(["sent"]);
  });

  it("tells the two Players of one Match separately", async () => {
    const { deps, sender } = await setup();
    expect((await push(deps, wire(), wire({ authority: B }))).outcomes).toEqual(["sent", "skipped"]);
    expect(sender.sent).toHaveLength(1);
  });

  it("refuses a wrong secret and malformed events", async () => {
    const { deps } = await setup();
    await expect(handleEvents(deps, SECRET, "Bearer no", { events: [wire()] })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(handleEvents(deps, undefined, `Bearer ${SECRET}`, { events: [wire()] })).rejects.toMatchObject({ code: "not-configured" });
    for (const bad of [null, {}, { events: "x" }, { events: [{ kind: "nope" }] }, { events: [wire({ authority: "short" })] }, { events: [wire({ game: "chess" })] }, { events: [wire({ entry: -1 })] }]) {
      await expect(handleEvents(deps, SECRET, `Bearer ${SECRET}`, bad)).rejects.toMatchObject({ code: "bad-request" });
    }
  });

  it("builds ids from the facts: an Advance paid back again after a new Advance is a new event", () => {
    const ids = parseEvents({ events: [{ kind: "debt-cleared", authority: A, positionId: "P", advance: 0, asset: "SOL" }, { kind: "debt-cleared", authority: A, positionId: "P", advance: 1, asset: "SOL" }] }).map((e) => e.id);
    expect(ids).toEqual(["debt-cleared:P:0", "debt-cleared:P:1"]);
  });
});

describe("daily digest", () => {
  it("emails 5 events, holds from the 6th, then one digest email sends and clears them", async () => {
    const { deps, sender, store } = await setup();
    const outcomes: string[] = [];
    for (let i = 1; i <= 8; i++) outcomes.push(...(await push(deps, wire({ matchId: String(i) }))).outcomes);
    expect(outcomes).toEqual(["sent", "sent", "sent", "sent", "sent", "digest", "digest", "digest"]);
    expect(sender.sent).toHaveLength(5);

    const first = await handleDigest(deps, SECRET, `Bearer ${SECRET}`);
    expect(first).toEqual({ sent: 1, dropped: 0 });
    expect(sender.sent).toHaveLength(6);
    expect(sender.sent[5].subject).toBe("Your Tesoro update: 3 things happened");
    expect(sender.sent[5].text.match(/^- /gm)).toHaveLength(3);
    expect((await store.get(A))?.digest).toEqual([]);

    expect(await handleDigest(deps, SECRET, `Bearer ${SECRET}`)).toEqual({ sent: 0, dropped: 0 });
    expect(sender.sent).toHaveLength(6);
  });

  it("keeps the messages when the send fails, and drops them for an Account that turned emails off", async () => {
    const { deps, sender, store } = await setup();
    await store.addDigest(A, "d", { subject: "s", body: "b" });
    sender.fail = true;
    await expect(handleDigest(deps, SECRET, `Bearer ${SECRET}`)).rejects.toThrow();
    expect((await store.get(A))?.digest).toHaveLength(1);
    sender.fail = false;
    await store.setEnabled(A, false);
    expect(await handleDigest(deps, SECRET, `Bearer ${SECRET}`)).toEqual({ sent: 0, dropped: 1 });
    expect((await store.get(A))?.digest).toEqual([]);
    await expect(handleDigest(deps, SECRET, "Bearer no")).rejects.toMatchObject({ code: "unauthorized" });
    expect(digestEmail("a@b.co", [{ subject: "s", body: "One." }], "https://t").subject).toBe("Your Tesoro update: 1 thing happened");
  });
});
