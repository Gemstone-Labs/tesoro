import { footer, type Email } from "./decide";
import type { NotifyDeps } from "./service";
import { BRAND } from "../../lib/brand";

export interface DigestSummary {
  sent: number;
  /** Held messages dropped because the Player has no verified address or turned emails off. */
  dropped: number;
}

/** One email for everything held back: the day's extra events, a line each. */
export function digestEmail(to: string, messages: { subject: string; body: string }[], siteUrl: string): Email {
  const n = messages.length;
  return {
    to,
    subject: `Your ${BRAND.name} update: ${n} ${n === 1 ? "thing" : "things"} happened`,
    text: `Here is what happened since your last email:\n\n${messages.map((m) => `- ${m.body}`).join("\n")}${footer(siteUrl)}`,
  };
}

/**
 * Sends one digest to each Player with held messages, then clears what it took. Run once a day. A send
 * that fails leaves the messages held for the next run.
 */
export async function sendDigests(deps: NotifyDeps): Promise<DigestSummary> {
  const out: DigestSummary = { sent: 0, dropped: 0 };
  for (const { authority, record } of await deps.store.digestHolders()) {
    const held = record.digest;
    if (record.verified && record.enabled) {
      await deps.sender.send(digestEmail(record.email, held, deps.siteUrl));
      out.sent++;
    } else out.dropped += held.length;
    await deps.store.clearDigest(authority, held.length);
  }
  return out;
}
