import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { NotifyStore } from "../notify/store";
import { WindowLimiter, takeAll } from "../rate-limit";
import { hashCode, normalizeCode, type InviteStore } from "./store";
import { BRAND } from "../../lib/brand";

export interface RedeemDeps {
  invites: InviteStore;
  notify: NotifyStore;
  /** True when the wallet already has its Tesoro Account (nothing to redeem for). */
  accountExists: (authority: string) => Promise<boolean>;
  /** A `create_account` transaction with the Player as fee payer, signed by the Invite key and not by the Player; base64. */
  buildCoSigned: (authority: string) => Promise<string>;
  token?: () => string;
}

const nonces = new NonceStore();
// Wrong guesses are the cost to an attacker; 80-bit codes make guessing hopeless, these keep the store quiet.
const byAuthority = new WindowLimiter(10, 60 * 60_000);
const bySub = new WindowLimiter(20, 60 * 60_000);
const CODE = /^[0-9A-Z]{16}$/;

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Redeems an Invite code for the signing wallet: checks the code, marks it used by that wallet, makes its email the
 * Account's verified notification email, and only then co-signs. The same wallet may ask again (a new co-signed
 * transaction); another wallet is refused.
 */
export async function handleRedeem(deps: RedeemDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<{ tx: string }> {
  const req = await verifySignedRequest("tesoro-invite", ["redeem"] as const, body, authorization, { nonces, env, now });
  const authority = req.address.toBase58();
  const code = typeof req.fields.code === "string" ? normalizeCode(req.fields.code) : "";
  if (!CODE.test(code)) throw new DemoHttpError(400, "bad-code", "That Invite code doesn’t look right.");
  if (!takeAll([[byAuthority, authority], ...(req.sub ? ([[bySub, req.sub]] as const) : [])])) {
    throw new DemoHttpError(429, "rate-limited", "Too many tries. Try again in an hour.");
  }
  if (await deps.accountExists(authority)) throw new DemoHttpError(409, "has-account", `This wallet already has a ${BRAND.name} Account.`);

  const claim = await deps.invites.claim(hashCode(code), authority);
  if (claim.state === "unknown") throw new DemoHttpError(404, "unknown-code", "That Invite code isn’t valid.");
  if (claim.state === "other") throw new DemoHttpError(403, "code-used", "That Invite code has already been used.");

  const record = await deps.notify.get(authority);
  if (claim.state === "claimed" || !record) {
    const token = (deps.token ?? randomToken)();
    await deps.notify.saveEmail(authority, claim.email, token);
    await deps.notify.verify(token);
  }
  return { tx: await deps.buildCoSigned(authority) };
}
