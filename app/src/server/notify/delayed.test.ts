import { describe, expect, it } from "vitest";
import type { EmailSender } from "./sender";
import { MemoryNotifyStore } from "./store";
import { MemoryOpenMatchStore } from "./open-match";
import { delayedPass } from "./delayed";

const A = { account: "accountA", authority: "authorityOfA" };
const B = { account: "accountB", authority: "authorityOfB" };
const JOIN = 1_800_000_000;

async function setup(game: "block-puzzle" | "trading-duel" = "block-puzzle") {
  const matches = new MemoryOpenMatchStore();
  const store = new MemoryNotifyStore();
  const sent: { to: string; subject: string; text: string }[] = [];
  const sender: EmailSender = { send: async (e) => void sent.push(e) };
  for (const p of [A, B]) {
    await store.saveEmail(p.authority, `${p.authority}@example.com`, p.authority);
    await store.verify(p.authority);
  }
  await matches.open({ matchState: "m1", matchKey: "accountA-1", game, entry: 100, opener: A });
  const notify = { store, sender, siteUrl: "https://example.test" };
  const at = (secs: number, over: { notify?: typeof notify | null } = {}) => delayedPass({ matches, notify: over.notify === undefined ? notify : over.notify, now: () => secs * 1000 });
  return { matches, store, sent, at, notify };
}

describe("the Delayed email", () => {
  it("waits for a second Player: an open Match has no deadline to miss", async () => {
    const t = await setup();
    expect(await t.at(JOIN + 100_000)).toEqual({ told: 0 });
    expect(t.sent).toHaveLength(0);
  });

  it("goes to both Players once the Match is past its time, with the refund deadline", async () => {
    const t = await setup();
    await t.matches.join("m1", B, JOIN + 3600);
    expect(await t.at(JOIN + 3000)).toEqual({ told: 0 });
    expect(await t.at(JOIN + 3601)).toEqual({ told: 1 });
    expect(t.sent.map((e) => e.to).sort()).toEqual(["authorityOfA@example.com", "authorityOfB@example.com"]);
    expect(t.sent[0].subject).toBe("Your Block Burst Match is delayed");
    expect(t.sent[0].text).toContain("refund is open now");
  });

  it("is sent once: a later pass, even with the flag lost, mails nobody again", async () => {
    const t = await setup();
    await t.matches.join("m1", B, JOIN + 3600);
    await t.at(JOIN + 4000);
    await t.at(JOIN + 5000);
    t.matches.rows.get("m1")!.told = false;
    await t.at(JOIN + 6000);
    expect(t.sent).toHaveLength(2);
  });

  it("follows each Game's own rule: a Duel is late minutes after the join, not at the refund deadline", async () => {
    const t = await setup("trading-duel");
    await t.matches.join("m1", B, JOIN + 3600);
    expect(await t.at(JOIN + 500)).toEqual({ told: 0 });
    expect(await t.at(JOIN + 700)).toEqual({ told: 1 });
    expect(t.sent[0].text).toContain("If it does not settle, it is refunded by");
  });

  it("skips a Match that has settled", async () => {
    const t = await setup();
    await t.matches.join("m1", B, JOIN + 3600);
    await t.matches.close("m1");
    expect(await t.at(JOIN + 9999)).toEqual({ told: 0 });
  });

  it("sends nothing and keeps the Match for later when email is not set up", async () => {
    const t = await setup();
    await t.matches.join("m1", B, JOIN + 3600);
    expect(await t.at(JOIN + 9999, { notify: null })).toEqual({ told: 0 });
    expect(await t.at(JOIN + 10_000)).toEqual({ told: 1 });
  });
});
