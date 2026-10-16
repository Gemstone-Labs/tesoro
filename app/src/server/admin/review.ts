import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import { reviewFlags, type ReviewReply, type ReviewSeason, type SeasonInput } from "@/lib/review/flags";
import { seasonAt, seasonEnd } from "@/lib/chain/season";

/** The window after a Season ends in which the admin may void a Player (ADR 0012). */
export const PAYOUT_WINDOW_SECS = 48 * 60 * 60;

export interface ReviewDeps {
  /** Wallets allowed in, base58 (parsed from ADMIN_WALLETS). */
  admins: string[];
  /** Public chain reads for these Seasons. */
  load: (seasons: number[]) => Promise<SeasonInput[]>;
}

const nonces = new NonceStore();
const STEPS = ["review"] as const;

/** `ADMIN_WALLETS`: comma separated base58 wallet addresses. Blank entries are ignored. */
export const parseAdmins = (raw: string | undefined): string[] => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The Seasons to review at `nowSecs`: this one, and the previous one while its payout window is open. */
export function reviewSeasons(nowSecs: number): ReviewSeason[] {
  const n = seasonAt(nowSecs);
  if (n < 1) return [];
  const out: ReviewSeason[] = [{ number: n, phase: "current" }];
  if (n > 1 && nowSecs < seasonEnd(n - 1) + PAYOUT_WINDOW_SECS) out.push({ number: n - 1, phase: "payout-window", windowEnds: seasonEnd(n - 1) + PAYOUT_WINDOW_SECS });
  return out;
}

/** Admin-only: a wallet-signed request from an address in ADMIN_WALLETS. Anyone else gets the same plain refusal. */
export async function handleReview(deps: ReviewDeps, body: unknown, authorization: string | null, env?: AuthEnv, now = Date.now()): Promise<ReviewReply> {
  if (!deps.admins.length) throw new DemoHttpError(503, "not-configured", "The review page is not set up on this server.");
  const req = await verifySignedRequest("tesoro-admin", STEPS, body, authorization, { nonces, env, now });
  if (!deps.admins.includes(req.address.toBase58())) throw new DemoHttpError(403, "forbidden", "Not allowed.");
  const nowSecs = Math.floor(now / 1000);
  const seasons = reviewSeasons(nowSecs);
  const inputs = await deps.load(seasons.map((s) => s.number));
  return { now: nowSecs, seasons, flags: reviewFlags(inputs) };
}
