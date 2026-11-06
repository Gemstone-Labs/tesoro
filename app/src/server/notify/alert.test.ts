import { describe, expect, it } from "vitest";
import { DemoHttpError } from "../request-auth";
import { handleAlert, secretOk } from "./alert";
import { ResendSender, type Email, type EmailSender } from "./sender";

const SECRET = "s3cret";

class FakeSender implements EmailSender {
  sent: Email[] = [];
  fail = false;
  async send(email: Email) {
    if (this.fail) throw new Error("down");
    this.sent.push(email);
  }
}

function setup() {
  const sender = new FakeSender();
  return { sender, deps: sender };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

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
  const alert = (deps: EmailSender, raw: unknown = body, auth: string | null = `Bearer ${SECRET}`, to: string | undefined = emails) => handleAlert(deps, SECRET, auth, raw, to);

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

describe("the shared secret", () => {
  it("accepts only the exact bearer secret", () => {
    expect(secretOk(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(secretOk("Bearer nope", SECRET)).toBe(false);
    expect(secretOk(null, SECRET)).toBe(false);
    expect(secretOk(`Bearer ${SECRET}`, undefined)).toBe(false);
  });
});
