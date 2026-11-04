import { PublicKey } from "@solana/web3.js";
import { DemoHttpError, verifySignedRequest, type AuthEnv, type NonceStore } from "../request-auth";
import { parseIntentText } from "./intent";
import type { Sponsor } from "./service";

/**
 * `build` is vouched for by the wallet's signature, or by the Match's Seat key (which names its Match in `match` and may only
 * ask for that Match's finish steps); `entry` carries no wallet signature, only the Privy login, and builds an entry alone;
 * `table` asks for the table of a joined Match whose join went out without one (wallet or that Match's seat key).
 */
export async function handleBuild(sponsor: Pick<Sponsor, "build" | "buildTable">, nonces: NonceStore, body: unknown, authorization: string | null, identityToken: string | null = null, env?: AuthEnv, now?: number) {
  const req = await verifySignedRequest("tesoro-sponsor", ["build", "entry", "table"] as const, body, authorization, { nonces, env, now, seatKey: true, tokenOnly: ["entry"], identityToken });
  let match: PublicKey | null = null;
  if (req.seat || req.step === "table") {
    try {
      match = new PublicKey(String(req.fields.match));
    } catch {
      throw new DemoHttpError(400, "bad-request", "A Seat key request names its Match.");
    }
  }
  if (req.step === "table" && match) return sponsor.buildTable(req.address, match, req.seat ? { kind: "seat", signer: req.signer, match } : { kind: "wallet" });
  const auth = req.seat && match ? ({ kind: "seat", signer: req.signer, match } as const) : req.step === "entry" ? ({ kind: "token" } as const) : ({ kind: "wallet" } as const);
  return sponsor.build(req.address, parseIntentText(req.fields.intent), req.sub, auth);
}

/** A join the Player pays for, with its table assigned: the wallet signs the request, or the login alone (`entry`). Never a Seat key. */
export async function handleAssign(sponsor: Pick<Sponsor, "buildSelfPaid">, nonces: NonceStore, body: unknown, authorization: string | null, identityToken: string | null = null, env?: AuthEnv, now?: number) {
  const req = await verifySignedRequest("tesoro-sponsor", ["assign", "entry"] as const, body, authorization, { nonces, env, now, tokenOnly: ["entry"], identityToken });
  return sponsor.buildSelfPaid(req.address, parseIntentText(req.fields.intent), req.sub, req.step === "entry" ? { kind: "token" } : { kind: "wallet" });
}
