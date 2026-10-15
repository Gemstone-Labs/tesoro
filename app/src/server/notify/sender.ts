import type { Email } from "./decide";

/** Sends one email. Resend in production; a fake in tests. */
export interface EmailSender {
  send(email: Email): Promise<void>;
}

/** Resend over HTTPS. `from` is an address on the sending subdomain, e.g. "Tesoro <hello@mail.playtesoro.com>". */
export class ResendSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(email: Email) {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text }),
    });
    if (!res.ok) throw new Error(`Resend rejected the email (${res.status})`);
  }
}

/** Resend when RESEND_API_KEY and NOTIFY_FROM are set; otherwise null. */
export function senderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender | null {
  return env.RESEND_API_KEY && env.NOTIFY_FROM ? new ResendSender(env.RESEND_API_KEY, env.NOTIFY_FROM) : null;
}
