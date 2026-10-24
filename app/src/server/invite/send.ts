import type { Email } from "../notify/decide";
import type { EmailSender } from "../notify/sender";
import { hashCode, newInviteCode, type InviteStore } from "./store";
import { BRAND } from "../../lib/brand";

export interface Member {
  email: string;
  createdAt: string;
}

export interface RunOptions {
  members: Member[];
  invites: InviteStore;
  sender: EmailSender;
  /** The mainnet site origin, no trailing slash. */
  site: string;
  /** False (the default) prints the plan and touches nothing. */
  send?: boolean;
  limit?: number;
  /** Issue a fresh code to members who already got one (the old unused code stops working). */
  resend?: boolean;
  /** Pause between sends, to stay under the email provider's rate limit. */
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (line: string) => void;
}

export interface RunResult {
  planned: number;
  sent: number;
  failed: number;
  skippedRedeemed: number;
  skippedSent: number;
}

/** The Invite email: what Tesoro is, the code, a link that pre-fills it, and that it works once. */
export function inviteEmail(site: string, code: string): Omit<Email, "to"> {
  const link = `${site}/play?invite=${code}`;
  return {
    subject: `Your ${BRAND.name} Invite`,
    text: [
      `${BRAND.name} is where you play skill games now and pay later, with the yield on your staked crypto.`,
      "",
      "You are on the waitlist and your Invite is ready.",
      "",
      `Your Invite code: ${code}`,
      "",
      "Open this link, sign in with your wallet, and the code is already filled in:",
      link,
      "",
      "The code works once, for one wallet. Please do not share it.",
    ].join("\n"),
  };
}

/**
 * Plans (and, with `send`, performs) one Invite email per waitlist member, oldest first.
 * Members who redeemed are skipped; members with a sent unused Invite are skipped unless `resend`.
 * A reissue creates and sends the new code first and only then deletes the old unused ones, so a
 * failed send never leaves a member without a working code.
 */
export async function runInvites(o: RunOptions): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => new Date().toISOString());
  const res: RunResult = { planned: 0, sent: 0, failed: 0, skippedRedeemed: 0, skippedSent: 0 };
  const ordered = [...o.members].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let first = true;

  for (const m of ordered) {
    if (o.limit !== undefined && res.planned >= o.limit) break;
    const rows = await o.invites.forEmail(m.email);
    if (rows.some((r) => r.used)) {
      res.skippedRedeemed++;
      log(`skip ${m.email}: already redeemed`);
      continue;
    }
    if (!o.resend && rows.some((r) => r.sentAt !== null)) {
      res.skippedSent++;
      log(`skip ${m.email}: already sent (use --resend for a fresh code)`);
      continue;
    }
    res.planned++;
    const code = newInviteCode();
    if (!o.send) {
      const mail = inviteEmail(o.site, "XXXX-XXXX-XXXX-XXXX");
      log(`would send to ${m.email}${rows.length ? " (replaces its unused code)" : ""}\n  subject: ${mail.subject}\n${mail.text.replace(/^/gm, "  | ")}`);
      continue;
    }
    if (!first) await wait(o.delayMs ?? 600);
    first = false;
    const hash = hashCode(code);
    await o.invites.create(hash, m.email);
    try {
      await o.sender.send({ to: m.email, ...inviteEmail(o.site, code) });
    } catch (e) {
      await o.invites.deleteUnused([hash]);
      res.failed++;
      log(`FAILED ${m.email}: ${(e as Error).message}`);
      continue;
    }
    await o.invites.markSent(hash, now());
    await o.invites.deleteUnused(rows.map((r) => r.codeHash));
    res.sent++;
    log(`sent ${m.email}`);
  }
  log(`${o.send ? "done" : "dry run, nothing sent"}: ${res.planned} planned, ${res.sent} sent, ${res.failed} failed, ${res.skippedRedeemed} redeemed, ${res.skippedSent} already sent`);
  return res;
}
