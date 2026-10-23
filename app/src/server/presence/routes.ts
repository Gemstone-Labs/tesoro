import { accountKeyOf } from "../../lib/chain/account-key";
import { parseMatchKey } from "../../lib/chain/match-id";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import { WindowLimiter } from "../rate-limit";
import { freshKeys, parseIds, type PresenceStore } from "./lease";

const nonces = new NonceStore();
/** One Player touches every 15 s: 12 a minute leaves room for a few open tabs. */
const limiter = new WindowLimiter(12, 60_000);

export interface PresenceDeps {
  store: PresenceStore;
  now?: () => number;
}

/** The opener of a Queue Match says "still here". Only the Match's opener can touch its row. */
export async function handleTouch(deps: PresenceDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<{ ok: true }> {
  const req = await verifySignedRequest("tesoro-presence", ["touch"] as const, body, authorization, { nonces, env, now });
  const match = String(req.fields.match ?? "");
  const key = parseMatchKey(match);
  if (!key) throw new DemoHttpError(400, "bad-request", "Malformed request.");
  if (key.opener !== accountKeyOf(req.address.toBase58())) throw new DemoHttpError(403, "not-opener", "Only the Player who opened the Match can do that.");
  if (!limiter.take(req.address.toBase58(), 1, deps.now?.())) throw new DemoHttpError(429, "too-many", "Too many requests.");
  await deps.store.touch(match, new Date((deps.now ?? Date.now)()).toISOString());
  return { ok: true };
}

/** Which of the Matches have a fresh lease. */
export async function handleFresh(deps: PresenceDeps, rawIds: string | null): Promise<{ fresh: string[] }> {
  const ids = parseIds(rawIds);
  if (!ids) throw new DemoHttpError(400, "bad-request", "Send between 1 and 100 Match keys.");
  return { fresh: freshKeys(await deps.store.rows(ids), (deps.now ?? Date.now)()) };
}
