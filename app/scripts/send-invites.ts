/**
 * Emails Invites to waitlist members, oldest first. Dry run unless --send. See docs/invites.md.
 *
 *   pnpm --filter @tesoro/keeper exec tsx ../app/scripts/send-invites.ts [--limit N] [--send] [--resend]
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, NOTIFY_FROM; INVITE_SITE_URL overrides the
 * link origin (default https://www.playtesoro.com).
 */
import { createClient } from "@supabase/supabase-js";
import { runInvites, type Member } from "../src/server/invite/send";
import { senderFromEnv } from "../src/server/notify/sender";
import { type InviteRow, type InviteStore } from "../src/server/invite/store";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined;
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit needs a positive whole number");
if (flag("send") && flag("dry-run")) throw new Error("Pick --send or --dry-run, not both");
const send = flag("send");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what} failed: ${error.message}`);
};

const invites: InviteStore = {
  async create(codeHash, email) {
    const { error } = await db.from("invites").insert({ code_hash: codeHash, email });
    fail("Invite create", error);
  },
  async forEmail(email): Promise<InviteRow[]> {
    const { data, error } = await db.from("invites").select("code_hash, email, sent_at, used_by_authority").eq("email", email);
    fail("Invite read", error);
    return (data ?? []).map((r) => ({ codeHash: r.code_hash, email: r.email, sentAt: r.sent_at, used: r.used_by_authority !== null }));
  },
  async markSent(codeHash, at) {
    const { error } = await db.from("invites").update({ sent_at: at }).eq("code_hash", codeHash);
    fail("Invite mark sent", error);
  },
  async deleteUnused(hashes) {
    if (hashes.length === 0) return;
    const { error } = await db.from("invites").delete().in("code_hash", hashes).is("used_by_authority", null);
    fail("Invite delete", error);
  },
  claim: () => {
    throw new Error("not used by this command");
  },
};

const { data, error } = await db.from("waitlist").select("email, created_at").order("created_at", { ascending: true }).order("id", { ascending: true });
fail("Waitlist read", error);
const members: Member[] = (data ?? []).map((r) => ({ email: r.email, createdAt: r.created_at }));

const sender = send ? senderFromEnv() : { send: async () => {} };
if (!sender) throw new Error("Set RESEND_API_KEY and NOTIFY_FROM to send.");

console.log(send ? "SENDING" : "DRY RUN (pass --send to email)", `${members.length} on the waitlist`);
const result = await runInvites({
  members,
  invites: send ? invites : readOnly(invites),
  sender,
  site: (process.env.INVITE_SITE_URL ?? "https://www.playtesoro.com").replace(/\/+$/, ""),
  send,
  limit,
  resend: flag("resend"),
  log: console.log,
});
process.exit(result.failed > 0 ? 1 : 0);

/** Dry run reads Invites but cannot write any. */
function readOnly(store: InviteStore): InviteStore {
  const no = () => {
    throw new Error("dry run must not write");
  };
  return { forEmail: store.forEmail, create: no, markSent: no, deleteUnused: no, claim: no };
}
