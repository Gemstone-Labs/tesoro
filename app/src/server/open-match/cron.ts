import { DemoHttpError } from "../request-auth";
import { secretOk } from "../notify/alert";

export interface CronPasses {
  pending: () => Promise<{ processed: number; failed: number }>;
  prune: () => Promise<{ pruned: number }>;
}

/**
 * The open-Match cron (`Authorization: Bearer $CRON_SECRET`): tracks the stored webhook transactions the webhook's own
 * after-response work has not reached, then prunes old rows. Each runs even when the other fails. It sends no email.
 */
export async function runOpenMatchCron(passes: CronPasses, secret: string | undefined, authorization: string | null): Promise<{ processed: number; failed: number; pruned: number }> {
  if (!secret) throw new DemoHttpError(503, "not-configured", "The open-Match cron is not configured on this server.");
  if (!secretOk(authorization, secret)) throw new DemoHttpError(401, "unauthorized", "Not allowed.");
  const [pending, prune] = await Promise.allSettled([passes.pending(), passes.prune()]);
  if (pending.status === "rejected") throw pending.reason;
  if (prune.status === "rejected") throw prune.reason;
  return { ...pending.value, pruned: prune.value.pruned };
}
