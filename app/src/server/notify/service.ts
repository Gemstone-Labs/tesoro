import { DemoHttpError } from "../request-auth";
import { decide, type NotifyEvent } from "./decide";
import type { EmailSender } from "./sender";
import { sentOn, type NotifyStore } from "./store";

export interface NotifyDeps {
  store: NotifyStore;
  sender: EmailSender;
  siteUrl: string;
  now?: () => number;
  token?: () => string;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EventOutcome = "sent" | "digest" | "skipped" | "duplicate";

/** Handles one event: at most once per event id, emailed only as `decide` allows. */
export async function handleEvent(deps: NotifyDeps, event: NotifyEvent): Promise<EventOutcome> {
  const now = (deps.now ?? Date.now)();
  const day = dayOf(now);
  if (!(await deps.store.claimEvent(event.id, event.authority))) return "duplicate";
  try {
    const record = await deps.store.get(event.authority);
    const d = decide(event, record, sentOn(record, day), deps.siteUrl);
    for (const email of d.emails) {
      await deps.sender.send(email);
      await deps.store.recordSent(event.authority, day);
    }
    for (const m of d.digest) await deps.store.addDigest(event.authority, day, m);
    return d.emails.length ? "sent" : d.digest.length ? "digest" : "skipped";
  } catch (e) {
    // Not delivered: let the same event come in again.
    await deps.store.releaseEvent(event.id);
    throw e;
  }
}

export interface NotifyStatus {
  email: string | null;
  verified: boolean;
  enabled: boolean;
}

export async function status(deps: NotifyDeps, authority: string): Promise<NotifyStatus> {
  const r = await deps.store.get(authority);
  return { email: r?.email ?? null, verified: r?.verified ?? false, enabled: r?.enabled ?? true };
}

/** Saves an address and mails the verify link. Nothing else is sent to it until it is verified. */
export async function setEmail(deps: NotifyDeps, authority: string, email: string): Promise<NotifyStatus> {
  const address = email.trim();
  if (address.length > 254 || !EMAIL.test(address)) throw new DemoHttpError(400, "bad-email", "That email address doesn’t look right.");
  const token = (deps.token ?? randomToken)();
  await deps.store.saveEmail(authority, address, token);
  await deps.sender.send({
    to: address,
    subject: "Confirm your email for Tesoro",
    text: `Confirm this address to get an email when your Match settles:\n${deps.siteUrl}/api/notify/verify?token=${token}\n\nIf this wasn’t you, ignore this email and nothing will be sent.`,
  });
  return status(deps, authority);
}

export async function setEnabled(deps: NotifyDeps, authority: string, enabled: boolean): Promise<NotifyStatus> {
  await deps.store.setEnabled(authority, enabled);
  return status(deps, authority);
}

export async function verifyToken(deps: NotifyDeps, token: string): Promise<boolean> {
  return /^[0-9a-f]{32}$/.test(token) && (await deps.store.verify(token)) !== null;
}

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
