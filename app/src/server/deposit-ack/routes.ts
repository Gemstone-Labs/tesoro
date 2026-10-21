import { DEPOSIT_ACK_VERSION } from "../../lib/deposit/acknowledgment";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { DepositAckStore } from "./store";

export interface DepositAckDeps {
  store: DepositAckStore;
  now?: () => number;
}

export interface DepositAckStatus {
  /** True once the Account acknowledged the current wording version. */
  acknowledged: boolean;
}

const nonces = new NonceStore();

/** The Account's own deposit acknowledgment, wallet-signed like the other server routes. `confirm` is idempotent. */
export async function handleDepositAck(deps: DepositAckDeps, body: unknown, authorization: string | null, env?: AuthEnv, now?: number): Promise<DepositAckStatus> {
  const req = await verifySignedRequest("tesoro-deposit-ack", ["status", "confirm"] as const, body, authorization, { nonces, env, now });
  if (req.fields.version !== DEPOSIT_ACK_VERSION) {
    throw new DemoHttpError(400, "wrong-version", "These terms have changed. Reload the page and read them again.");
  }
  const authority = req.address.toBase58();
  if (req.step === "confirm") await deps.store.confirm(authority, DEPOSIT_ACK_VERSION, new Date((deps.now ?? Date.now)()).toISOString());
  return { acknowledged: (await deps.store.get(authority, DEPOSIT_ACK_VERSION)) !== null };
}
