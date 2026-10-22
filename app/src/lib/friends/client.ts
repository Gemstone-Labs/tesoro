import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { newNonce, signedMessage } from "@/lib/chain/signed-request";

/** What `/api/friends` answers for `op: "list"` (server/friends/routes.ts FriendsView). */
export interface FriendsView {
  me: string;
  friends: { account: string; since: number; isNew: boolean }[];
  incoming: { account: string; at: number }[];
  outgoing: { account: string; at: number }[];
  challenges: { matchId: string; from: string; at: number; game: GameId; entry: number }[];
  badge: number;
}

/** What a Friends action answers: a plain status, an add-me link code, or a link's owner. */
export interface FriendsResult {
  status?: string;
  code?: string;
  owner?: string;
}

export class FriendsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type GetToken = () => Promise<string | null>;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function post(url: string, body: unknown, getToken: GetToken): Promise<Record<string, unknown>> {
  const token = await getToken().catch(() => null);
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new FriendsError(typeof json.code === "string" ? json.code : "error", typeof json.error === "string" ? json.error : "That didn’t go through. Try again in a moment.");
  return json as Record<string, unknown>;
}

/** One wallet signature starts a 30-day Friends session (an HttpOnly cookie). Answers the session's Account key. */
export async function startFriendsSession(signer: ChainSigner, getToken: GetToken): Promise<string> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-friends", "session", address, ts, nonce, {})));
  const r = await post("/api/friends/session", { step: "session", address, ts, nonce, signature: b64(signature) }, getToken);
  return r.account as string;
}

/** One Friends action for the session's Account. Throws FriendsError("no-session") when a session is needed first. */
export const friendsCall = (op: string, args: Record<string, unknown>, getToken: GetToken): Promise<unknown> => post("/api/friends", { op, ...args }, getToken);
