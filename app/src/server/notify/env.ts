import "server-only";
import { DemoHttpError } from "../request-auth";
import { senderFromEnv } from "./sender";
import type { NotifyDeps } from "./service";
import { supabaseNotifyStore } from "./supabase-store";

export const siteUrl = () => process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.playtesoro.com";

/** The production wiring: Supabase store, Resend sender. Fails plainly when email is not set up. */
export function notifyDeps(): NotifyDeps {
  const sender = senderFromEnv();
  if (!sender) throw new DemoHttpError(503, "not-configured", "Email is not set up on this server.");
  return { store: supabaseNotifyStore, sender, siteUrl: siteUrl() };
}
