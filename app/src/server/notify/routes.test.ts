import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import type { Email } from "./decide";
import { handleAlert, handleSettings, handleSettled, secretOk } from "./routes";
import type { EmailSender } from "./sender";
import { ResendSender } from "./sender";
import { handleEvent, verifyToken, type NotifyDeps } from "./service";
import { MemoryNotifyStore } from "./store";

const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const SECRET = "s3cret";
const TOKEN = "ab".repeat(16);

class FakeSender implements EmailSender {
  sent: Email[] = [];
  fail = false;
  async send(email: Email) {
    if (this.fail) throw new Error("down");
    this.sent.push(email);
  }
}

function setup() {
  const store = new MemoryNotifyStore();
  const sender = new FakeSender();
  const deps: NotifyDeps = { store, sender, siteUrl: "https://test.example", now: () => NOW, token: () => TOKEN };
  return { store, sender, deps };
}

function signed(kp: Keypair, step: string, fields: SignedFields = {}) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-notify", step, address, NOW, nonce, fields)), kp.secretKey);
  return { step, address, ts: NOW, nonce, signature: Buffer.from(sig).toString("base64"), ...fields };
}

const settings = (deps: NotifyDeps, body: unknown) => handleSettings(deps, body, null, dev, NOW);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

const push = (authority: string, over: object = {}) => ({
  matchId: "123456",
  game: "block-puzzle",
  entry: 1000,
  participants: [{ authority, result: "won", gemas: 980 }],
  ...over,
});
const settled = (deps: NotifyDeps, body: unknown, auth: string | null = `Bearer ${SECRET}`) => handleSettled(deps, SECRET, auth, body);

describe("email opt-in", () => {
  it("saves the address unverified, mails a verify link, and mails nothing else until it is verified", async () => {
    const { deps, sender } = setup();
    const kp = Keypair.generate();
    const a = kp.publicKey.toBase58();
    const s = await settings(deps, signed(kp, "set-email", { email: "p@example.com" }));
    expect(s).toEqual({ email: "p@example.com", verified: false, enabled: true });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain(`https://test.example/api/notify/verify?token=${TOKEN}`);

    await settled(deps, push(a));
    expect(sender.sent).toHaveLength(1);

    expect(await verifyToken(deps, TOKEN)).toBe(true);
    expect((await settings(deps, signed(kp, "status"))).verified).toBe(true);
    expect(await verifyToken(deps, TOKEN)).toBe(false);
    await settled(deps, push(a, { matchId: "9" }));
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].to).toBe("p@example.com");
  });

  it("rejects a bad address and an unsigned or tampered request", async () => {
    const { deps } = setup();
    const kp = Keypair.generate();
    expect(await code(settings(deps, signed(kp, "set-email", { email: "nope" })))).toBe("bad-email");
    const body = signed(kp, "set-email", { email: "p@example.com" });
    expect(await code(settings(deps, { ...body, email: "evil@example.com" }))).toBe("bad-signature");
    expect(await code(settings(deps, { ...body, signature: "AAAA" }))).toBe("bad-signature");
  });

  it("caps verify emails to one address at 3 an hour", async () => {
    const { deps, sender } = setup();
    const to = { email: "capped@example.com" };
    for (let i = 0; i < 3; i++) expect(await code(settings(deps, signed(Keypair.generate(), "set-email", to)))).toBe("ok");
    expect(await code(settings(deps, signed(Keypair.generate(), "set-email", to)))).toBe("rate-limited");
    expect(sender.sent).toHaveLength(3);
  });

  it("the off switch stops all emails, and turning it back on restores them", async () => {
    const { deps, sender } = setup();
    const kp = Keypair.generate();
    await settings(deps, signed(kp, "set-email", { email: "p@example.com" }));
    await verifyToken(deps, TOKEN);
    sender.sent = [];
    expect((await settings(deps, signed(kp, "set-enabled", { enabled: 0 }))).enabled).toBe(false);
    await settled(deps, push(kp.publicKey.toBase58()));
    expect(sender.sent).toHaveLength(0);
    await settings(deps, signed(kp, "set-enabled", { enabled: 1 }));
    await settled(deps, push(kp.publicKey.toBase58(), { matchId: "77" }));
    expect(sender.sent).toHaveLength(1);
  });
});

describe("settled Match push", () => {
  async function optedIn(deps: NotifyDeps, kp = Keypair.generate()) {
    await settings(deps, signed(kp, "set-email", { email: `${kp.publicKey.toBase58().slice(0, 5)}@example.com` }));
    await verifyToken(deps, TOKEN);
    return kp.publicKey.toBase58();
  }

  it("emails each Player once, even when the same event arrives twice", async () => {
    const { deps, sender } = setup();
    const a = await optedIn(deps);
    sender.sent = [];
    const first = await settled(deps, push(a));
    const second = await settled(deps, push(a));
    expect(first.outcomes).toEqual(["sent"]);
    expect(second.outcomes).toEqual(["duplicate"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain("You won your Block Puzzle Match and 980 Gemas");
  });

  it("accepts a settled Vanguard Match and names the Game", async () => {
    const { deps, sender } = setup();
    const a = await optedIn(deps);
    sender.sent = [];
    const out = await settled(deps, { ...push(a), matchId: "88", game: "vanguard" });
    expect(out.outcomes).toEqual(["sent"]);
    expect(sender.sent[0].text).toContain("You won your Vanguard Match");
  });

  it("tells the winner and the loser separately and skips Players with no address", async () => {
    const { deps, sender } = setup();
    const a = await optedIn(deps);
    sender.sent = [];
    const body = push(a, {
      participants: [
        { authority: a, result: "lost", gemas: 1000 },
        { authority: Keypair.generate().publicKey.toBase58(), result: "won", gemas: 980 },
      ],
    });
    expect((await settled(deps, body)).outcomes).toEqual(["sent", "skipped"]);
    expect(sender.sent[0].subject).toBe("You lost your Block Puzzle Match");
  });

  it("sends at most 5 emails a day and holds the rest for the digest", async () => {
    const { deps, sender, store } = setup();
    const a = await optedIn(deps);
    sender.sent = [];
    const outcomes: string[] = [];
    for (let i = 1; i <= 7; i++) outcomes.push(...(await settled(deps, push(a, { matchId: String(i) }))).outcomes);
    expect(outcomes).toEqual(["sent", "sent", "sent", "sent", "sent", "digest", "digest"]);
    expect(sender.sent).toHaveLength(5);
    expect((await store.get(a))?.digest).toHaveLength(2);
  });

  it("allows the event to come again when the email could not be sent", async () => {
    const { deps, sender } = setup();
    const a = await optedIn(deps);
    sender.sent = [];
    sender.fail = true;
    await expect(settled(deps, push(a))).rejects.toThrow();
    sender.fail = false;
    expect((await settled(deps, push(a))).outcomes).toEqual(["sent"]);
    expect(sender.sent).toHaveLength(1);
  });

  it("refuses a wrong or missing secret and a malformed event", async () => {
    const { deps } = setup();
    expect(await code(settled(deps, push("a"), "Bearer nope"))).toBe("unauthorized");
    expect(await code(settled(deps, push("a"), null))).toBe("unauthorized");
    expect(await code(handleSettled(deps, undefined, `Bearer ${SECRET}`, push("a")))).toBe("not-configured");
    expect(await code(settled(deps, { matchId: "x" }))).toBe("bad-request");
    expect(await code(settled(deps, push("a", { game: "chess" })))).toBe("bad-request");
    expect(secretOk(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("handles an event directly through the service too", async () => {
    const { deps } = setup();
    const out = await handleEvent(deps, { kind: "match-settled", id: "x", authority: "nobody", matchId: "1", game: "holdem", result: "draw", gemas: 0, pot: 2 });
    expect(out).toBe("skipped");
  });
});

describe("Resend sender", () => {
  it("posts the email to Resend with the key and the from address", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    await new ResendSender("key", "Tesoro <hello@mail.playtesoro.com>", fake).send({ to: "p@example.com", subject: "Hi", text: "Body" });
    expect(seen?.url).toBe("https://api.resend.com/emails");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(seen?.init.body as string)).toEqual({ from: "Tesoro <hello@mail.playtesoro.com>", to: ["p@example.com"], subject: "Hi", text: "Body" });
    const bad = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(new ResendSender("k", "f", bad).send({ to: "a@b.co", subject: "s", text: "t" })).rejects.toThrow(/403/);
  });
});

describe("keeper alert", () => {
  const body = { kind: "alert", key: "job:price", title: "price job failing", detail: "5 failed passes in a row", source: "test" };
  const emails = "a@example.com, B@example.com";
  const alert = (deps: NotifyDeps, raw: unknown = body, auth: string | null = `Bearer ${SECRET}`, to: string | undefined = emails) => handleAlert(deps, SECRET, auth, raw, to);

  it("mails every address in ALERT_EMAILS and no one else", async () => {
    const { deps, sender } = setup();
    expect(await alert(deps)).toEqual({ sent: 2 });
    expect(sender.sent.map((e) => e.to)).toEqual(["a@example.com", "b@example.com"]);
    expect(sender.sent[0].subject).toBe("[Tesoro alert] price job failing");
    expect(sender.sent[0].text).toContain("5 failed passes in a row");
  });

  it("titles reminders and recoveries", async () => {
    const { deps, sender } = setup();
    await alert(deps, { ...body, kind: "reminder" });
    await alert(deps, { ...body, kind: "recovered" });
    expect(sender.sent.map((e) => e.subject)).toEqual(["[Tesoro reminder] price job failing", "[Tesoro reminder] price job failing", "[Tesoro recovered] price job failing", "[Tesoro recovered] price job failing"]);
  });

  it("refuses a wrong or missing secret, and a server with no secret or no recipients", async () => {
    const { deps, sender } = setup();
    expect(await code(alert(deps, body, "Bearer nope"))).toBe("unauthorized");
    expect(await code(alert(deps, body, null))).toBe("unauthorized");
    expect(await code(handleAlert(deps, undefined, `Bearer ${SECRET}`, body, emails))).toBe("not-configured");
    expect(await code(alert(deps, body, `Bearer ${SECRET}`, ""))).toBe("not-configured");
    expect(await code(handleAlert(deps, SECRET, `Bearer ${SECRET}`, body, undefined))).toBe("not-configured");
    expect(sender.sent).toHaveLength(0);
  });

  it("takes no recipient from the request", async () => {
    const { deps, sender } = setup();
    await alert(deps, { ...body, to: "evil@example.com", email: "evil@example.com" });
    expect(sender.sent.map((e) => e.to)).not.toContain("evil@example.com");
  });

  it("rejects a malformed alert", async () => {
    const { deps } = setup();
    expect(await code(alert(deps, { ...body, kind: "boom" }))).toBe("bad-request");
    expect(await code(alert(deps, { ...body, title: "" }))).toBe("bad-request");
    expect(await code(alert(deps, null))).toBe("bad-request");
  });

  it("fails (so the keeper retries) only when no address could be mailed", async () => {
    const { deps, sender } = setup();
    sender.fail = true;
    expect(await code(alert(deps))).toBe("send-failed");
  });
});
