import { timingSafeEqual } from "node:crypto";
import type { GameId } from "@/lib/mock/types";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { MatchSettledEvent } from "./decide";
import { handleEvent, setEmail, setEnabled, status, type EventOutcome, type NotifyDeps, type NotifyStatus } from "./service";

const STEPS = ["status", "set-email", "set-enabled"] as const;
const nonces = new NonceStore();

/** A Player's own settings: wallet-signed like the other server routes. */
export async function handleSettings(deps: NotifyDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<NotifyStatus> {
  const req = await verifySignedRequest("tesoro-notify", STEPS, body, authorization, { nonces, env, now });
  const authority = req.address.toBase58();
  if (req.step === "set-email") {
    if (typeof req.fields.email !== "string") throw new DemoHttpError(400, "bad-request", "Malformed request.");
    return setEmail(deps, authority, req.fields.email);
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

