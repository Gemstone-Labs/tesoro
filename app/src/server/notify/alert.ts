import { timingSafeEqual } from "node:crypto";
import { DemoHttpError } from "../request-auth";
import type { EmailSender } from "./sender";
import { BRAND } from "../../lib/brand";

/** True when `authorization` is `Bearer <secret>`. */
export function secretOk(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  const given = Buffer.from(authorization.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

export type AlertKind = "alert" | "reminder" | "recovered";
const ALERT_KINDS: AlertKind[] = ["alert", "reminder", "recovered"];

/** Recipients of keeper alerts: the founders, from the server's own env (ALERT_EMAILS, comma separated), never from a request. */
export const alertRecipients = (raw: string | undefined) =>
  [...new Set((raw ?? "").split(/[,\s;]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a)))];

/** The keeper's operations alerts (commits stuck, job failing, low balance, and their reminders and recoveries). Mailed to ALERT_EMAILS. */
export async function handleAlert(sender: EmailSender, secret: string | undefined, authorization: string | null, raw: unknown, emails: string | undefined): Promise<{ sent: number }> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "Notifications are not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  const to = alertRecipients(emails);
  if (!to.length) throw new DemoHttpError(503, "not-configured", "No alert recipients are set on this server.");
  const b = raw as { kind?: unknown; title?: unknown; detail?: unknown; source?: unknown } | null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  if (!b || typeof b !== "object" || !ALERT_KINDS.includes(b.kind as AlertKind) || !text(b.title, 120)) throw new DemoHttpError(400, "bad-request", "Malformed alert.");
  const kind = b.kind as AlertKind;
  const title = text(b.title, 120);
  const source = text(b.source, 40);
  const body = [text(b.detail, 1000), source && `Keeper: ${source}`, kind === "recovered" ? "This has cleared." : "Check the keeper and its logs."].filter(Boolean).join("\n\n");
  const results = await Promise.allSettled(to.map((addr) => sender.send({ to: addr, subject: `[${BRAND.name} ${kind}] ${title}`, text: body })));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  if (!sent) throw new DemoHttpError(502, "send-failed", "No alert email could be sent.");
  return { sent };
}
