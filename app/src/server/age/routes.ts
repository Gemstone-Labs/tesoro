import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { AgeStore } from "./store";

export interface AgeDeps {
  store: AgeStore;
  now?: () => number;
}

export interface AgeStatus {
  /** True once the Account has confirmed it is 18 or older. */
  confirmed: boolean;
}

const nonces = new NonceStore();

/** The Account's own 18+ confirmation, wallet-signed like the other server routes. `confirm` is idempotent. */
export async function handleAge(deps: AgeDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<AgeStatus> {
  const req = await verifySignedRequest("tesoro-age", ["status", "confirm"] as const, body, authorization, { nonces, env, now });
  const authority = req.address.toBase58();
  if (req.step === "confirm") await deps.store.confirm(authority, new Date((deps.now ?? Date.now)()).toISOString());
  return { confirmed: (await deps.store.get(authority)) !== null };
}
