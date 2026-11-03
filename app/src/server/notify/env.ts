import "server-only";
import { DemoHttpError } from "../request-auth";
import { SITE_URL } from "@/lib/site";
import { senderFromEnv } from "./sender";
import type { NotifyDeps } from "./service";
import { supabaseNotifyStore } from "./supabase-store";
import { baseRpc } from "@/lib/chain/rpc-config";
import { supabaseRpc } from "../history/db";
import { rpcNotifyChain } from "./chain";
import { delayedPass } from "./delayed";
import { rpcOpenMatchStore } from "./open-match";
import { notifyPending, rpcNotifyTxStore } from "./pending";

export const siteUrl = () => SITE_URL;

/** The production wiring: Supabase store, Resend sender. Fails plainly when email is not set up. */
export function notifyDeps(): NotifyDeps {
  const sender = senderFromEnv();
  if (!sender) throw new DemoHttpError(503, "not-configured", "Email is not set up on this server.");
  return { store: supabaseNotifyStore, sender, siteUrl: siteUrl() };
}

/** Like `notifyDeps`, but null when email is not set up (the webhook still has to keep the open-Match table). */
export function notifyDepsOrNull(): NotifyDeps | null {
  const sender = senderFromEnv();
  return sender ? { store: supabaseNotifyStore, sender, siteUrl: siteUrl() } : null;
}

/** The production wiring of the emails from stored webhook transactions. */
export function webhookNotifyPasses() {
  const notify = notifyDepsOrNull();
  const matches = rpcOpenMatchStore(supabaseRpc);
  return {
    pending: () => notifyPending({ txs: rpcNotifyTxStore(supabaseRpc), matches, chain: rpcNotifyChain(baseRpc(process.env.TESORO_BASE_RPC)), notify, warn: (m) => console.warn("notify", m) }),
    delayed: () => delayedPass({ matches, notify }),
  };
}
