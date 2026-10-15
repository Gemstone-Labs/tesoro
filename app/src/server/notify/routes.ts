import { timingSafeEqual } from "node:crypto";
import type { GameId } from "@/lib/mock/types";
import { takeAll, WindowLimiter } from "../rate-limit";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { MatchSettledEvent } from "./decide";
import { parseEvents } from "./events";
import { sendDigests, type DigestSummary } from "./digest";
import { handleEvent, setEmail, setEnabled, status, type EventOutcome, type NotifyDeps, type NotifyStatus } from "./service";
import { BRAND } from "../../lib/brand";

const STEPS = ["status", "set-email", "set-enabled"] as const;
const nonces = new NonceStore();
// Verify links go to addresses the caller typed: cap them per Account and per address.
const byAuthority = new WindowLimiter(5, 60 * 60_000);
const byAddress = new WindowLimiter(3, 60 * 60_000);

/** A Player's own settings: wallet-signed like the other server routes. */
export async function handleSettings(deps: NotifyDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<NotifyStatus> {
  const req = await verifySignedRequest("tesoro-notify", STEPS, body, authorization, { nonces, env, now });
  const authority = req.address.toBase58();
  if (req.step === "set-email") {
    if (typeof req.fields.email !== "string") throw new DemoHttpError(400, "bad-request", "Malformed request.");
    const refund = takeAll([
      [byAuthority, authority],
      [byAddress, req.fields.email.trim().toLowerCase()],
    ]);
    if (!refund) throw new DemoHttpError(429, "rate-limited", "Too many tries. Try again in an hour.");
    try {
      return await setEmail(deps, authority, req.fields.email);
    } catch (e) {
      refund();
      throw e;
    }
  }
  if (req.step === "set-enabled") return setEnabled(deps, authority, Number(req.fields.enabled) === 1);
  return status(deps, authority);
}

export interface SettledPush {
  matchId: string;
  game: GameId;
  entry: number;
  /** One per Player who played the Match. `gemas` is the amount won or lost after Fees. */
  participants: { authority: string; result: "won" | "lost" | "draw"; gemas: number }[];
}

const GAME_IDS = ["block-puzzle", "holdem", "trading-duel"];

/** True when `authorization` is `Bearer <secret>`. */
export function secretOk(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  const given = Buffer.from(authorization.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function parseSettled(raw: unknown): SettledPush {
  const b = raw as Partial<SettledPush> | null;
  const bad = () => new DemoHttpError(400, "bad-request", "Malformed event.");
  if (!b || typeof b !== "object" || typeof b.matchId !== "string" || !/^\d{1,20}$/.test(b.matchId)) throw bad();
  if (typeof b.game !== "string" || !GAME_IDS.includes(b.game) || typeof b.entry !== "number" || !Number.isFinite(b.entry) || !Array.isArray(b.participants)) throw bad();
  const participants = b.participants.map((p) => {
    if (!p || typeof p.authority !== "string" || !["won", "lost", "draw"].includes(p.result) || typeof p.gemas !== "number" || !Number.isFinite(p.gemas) || p.gemas < 0) throw bad();
    return { authority: p.authority, result: p.result, gemas: p.gemas };
  });
  return { matchId: b.matchId, game: b.game as GameId, entry: b.entry, participants };
}

/** The keeper's push of a settled Match, protected by the shared secret. Each Player is notified at most once per Match. */
export async function handleSettled(deps: NotifyDeps, secret: string | undefined, authorization: string | null, raw: unknown): Promise<{ outcomes: EventOutcome[] }> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "Notifications are not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  const push = parseSettled(raw);
  const outcomes: EventOutcome[] = [];
  for (const p of push.participants) {
    const event: MatchSettledEvent = {
      kind: "match-settled",
      id: `match-settled:${push.matchId}:${p.authority}`,
      authority: p.authority,
      matchId: push.matchId,
      game: push.game,
      result: p.result,
      gemas: p.gemas,
      pot: push.entry * 2,
    };
    outcomes.push(await handleEvent(deps, event));
  }
  return { outcomes };
}


/** The keeper's push of other events (see events.ts), protected by the shared secret. Each fact is told once. */
export async function handleEvents(deps: NotifyDeps, secret: string | undefined, authorization: string | null, raw: unknown): Promise<{ outcomes: EventOutcome[] }> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "Notifications are not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  const outcomes: EventOutcome[] = [];
  for (const event of parseEvents(raw)) outcomes.push(await handleEvent(deps, event));
  return { outcomes };
}

/** The keeper's once-a-day call: one digest email per Player with held messages, then the held messages are cleared. */
export async function handleDigest(deps: NotifyDeps, secret: string | undefined, authorization: string | null): Promise<DigestSummary> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "Notifications are not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  return sendDigests(deps);
}

export type AlertKind = "alert" | "reminder" | "recovered";
const ALERT_KINDS: AlertKind[] = ["alert", "reminder", "recovered"];

/** Recipients of keeper alerts: the founders, from the server's own env (ALERT_EMAILS, comma separated), never from a request. */
export const alertRecipients = (raw: string | undefined) =>
  [...new Set((raw ?? "").split(/[,\s;]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a)))];

/** The keeper's operations alerts (commits stuck, job failing, low balance, and their reminders and recoveries). Mailed to ALERT_EMAILS. */
export async function handleAlert(deps: NotifyDeps, secret: string | undefined, authorization: string | null, raw: unknown, emails: string | undefined): Promise<{ sent: number }> {
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
  const results = await Promise.allSettled(to.map((addr) => deps.sender.send({ to: addr, subject: `[${BRAND.name} ${kind}] ${title}`, text: body })));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  if (!sent) throw new DemoHttpError(502, "send-failed", "No alert email could be sent.");
  return { sent };
}
