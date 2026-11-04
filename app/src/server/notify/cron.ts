import { DemoHttpError } from "../request-auth";
import type { DigestSummary } from "./digest";
import { secretOk } from "./routes";

export interface CronPasses {
  pending: () => Promise<{ processed: number; failed: number }>;
  delayed: () => Promise<{ told: number }>;
}

/**
 * The notify cron (Vercel sends `Authorization: Bearer $CRON_SECRET`): emails for stored webhook transactions the webhook's own
 * after-response work has not reached, and the Delayed check. They run side by side and each runs even when the other fails.
 */
export async function runNotifyCron(passes: CronPasses, secret: string | undefined, authorization: string | null): Promise<{ processed: number; failed: number; delayed: number }> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "The notify cron is not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  const [pending, delayed] = await Promise.allSettled([passes.pending(), passes.delayed()]);
  if (pending.status === "rejected") throw pending.reason;
  if (delayed.status === "rejected") throw delayed.reason;
  return { ...pending.value, delayed: delayed.value.told };
}

/** The daily digest cron (the keeper no longer calls the digest once the app sends the emails): one digest email per Player with held messages. */
export async function runDigestCron(send: () => Promise<DigestSummary>, secret: string | undefined, authorization: string | null): Promise<DigestSummary> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "The digest cron is not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  return send();
}
