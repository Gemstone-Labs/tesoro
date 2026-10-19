import { describe, expect, it } from "vitest";
import type { Email } from "../notify/decide";
import type { EmailSender } from "../notify/sender";
import { hashCode, MemoryInviteStore, normalizeCode } from "./store";
import { inviteEmail, runInvites, type Member } from "./send";

class FakeSender implements EmailSender {
  sent: Email[] = [];
  failFor = new Set<string>();
  async send(e: Email) {
    if (this.failFor.has(e.to)) throw new Error("boom");
    this.sent.push(e);
  }
}

const members: Member[] = ["a@x.com", "b@x.com", "c@x.com"].map((email, i) => ({ email, createdAt: `2026-10-0${i + 1}` }));
const base = { site: "https://www.playtesoro.com", wait: async () => {}, now: () => "2026-10-15T00:00:00.000Z" };
const codeIn = (e: Email) => /invite=([0-9A-Z-]+)/.exec(e.text)![1];

function setup() {
  return { invites: new MemoryInviteStore(), sender: new FakeSender(), logs: [] as string[] };
}

describe("runInvites", () => {
  it("dry-run is the default: sends and writes nothing, redacts the code", async () => {
    const { invites, sender, logs } = setup();
    const r = await runInvites({ ...base, members, invites, sender, log: (l) => logs.push(l) });
    expect(r.planned).toBe(3);
    expect(sender.sent).toHaveLength(0);
    expect(invites.rows.size).toBe(0);
    expect(logs.join("\n")).toContain("a@x.com");
    expect(logs.join("\n")).toMatch(/invite=XXXX-XXXX-XXXX-XXXX/);
  });

  it("--send creates one Invite per member, oldest first, hashed, with sent_at, and the link carries the code", async () => {
    const { invites, sender } = setup();
    const r = await runInvites({ ...base, members: [...members].reverse(), invites, sender, send: true, log: () => {} });
    expect(r.sent).toBe(3);
    expect(sender.sent.map((e) => e.to)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    for (const e of sender.sent) {
      const code = codeIn(e);
      expect(e.text).toContain(`https://www.playtesoro.com/lobby?invite=${code}`);
      const row = invites.rows.get(hashCode(code))!;
      expect(row.email).toBe(e.to);
      expect(row.sentAt).toBe(base.now());
      expect(e.text).toMatch(/once/i);
    }
    expect(invites.rows.size).toBe(3);
  });

  it("--limit takes the oldest N", async () => {
    const { invites, sender } = setup();
    await runInvites({ ...base, members, invites, sender, send: true, limit: 2, log: () => {} });
    expect(sender.sent.map((e) => e.to)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("skips members who already have a sent Invite unless resending", async () => {
    const { invites, sender } = setup();
    await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    const again = await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    expect(again.sent).toBe(0);
    expect(sender.sent).toHaveLength(3);
  });

  it("resend issues a fresh code and invalidates the old unused one: one live code per member", async () => {
    const { invites, sender } = setup();
    await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    const old = codeIn(sender.sent[0]);
    await runInvites({ ...base, members: [members[0]], invites, sender, send: true, resend: true, log: () => {} });
    const fresh = codeIn(sender.sent[3]);
    expect(fresh).not.toBe(old);
    expect(invites.rows.has(hashCode(old))).toBe(false);
    expect([...invites.rows.values()].filter((r) => r.email === "a@x.com")).toHaveLength(1);
  });

  it("skips members who already redeemed, even on resend", async () => {
    const { invites, sender } = setup();
    await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    await invites.claim(hashCode(codeIn(sender.sent[0])), "wallet1");
    const r = await runInvites({ ...base, members, invites, sender, send: true, resend: true, log: () => {} });
    expect(r.skippedRedeemed).toBe(1);
    expect(sender.sent.filter((e) => e.to === "a@x.com")).toHaveLength(1);
  });

  it("a failed send leaves the old code alive and the new one unsent; the next run retries", async () => {
    const { invites, sender } = setup();
    sender.failFor.add("b@x.com");
    const r = await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(2);
    sender.failFor.clear();
    const r2 = await runInvites({ ...base, members, invites, sender, send: true, log: () => {} });
    expect(r2.sent).toBe(1);
    expect(sender.sent.at(-1)!.to).toBe("b@x.com");
    expect([...invites.rows.values()].filter((x) => x.email === "b@x.com")).toHaveLength(1);
  });

  it("waits between sends", async () => {
    const { invites, sender } = setup();
    const waits: number[] = [];
    await runInvites({ ...base, members, invites, sender, send: true, delayMs: 600, wait: async (ms) => void waits.push(ms), log: () => {} });
    expect(waits).toEqual([600, 600]);
  });
});

describe("inviteEmail", () => {
  it("normalizes to the stored hash", () => {
    const e = inviteEmail("https://s", "ABCD-EFGH-JKMN-PQRS");
    expect(normalizeCode("ABCD-EFGH-JKMN-PQRS")).toBe("ABCDEFGHJKMNPQRS");
    expect(e.text).toContain("https://s/lobby?invite=ABCD-EFGH-JKMN-PQRS");
  });
});
