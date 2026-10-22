import "server-only";
import { Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { gameOf } from "@/lib/chain/read";
import { isChallengeId } from "@/lib/chain/match-flow";
import { baseRpc } from "@/lib/chain/rpc-config";
import { notifyDeps } from "../notify/env";
import { handleEvent } from "../notify/service";
import type { FriendNotice, FriendsDeps, OpenChallenge } from "./routes";
import { MemoryFriendsStore, type FriendsStore } from "./store";
import { supabaseFriendsStore } from "./supabase-store";

const coder = new Program(coreIdl as Idl, {} as Provider).coder.accounts;
let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

/** A Challenge Match that is still waiting for its second Player, read from the base layer. */
export async function openChallenge(matchId: string): Promise<OpenChallenge | null> {
  const id = BigInt(matchId);
  if (!isChallengeId(id)) return null;
  const info = await connection().getAccountInfo(BlockPuzzleChain.addresses(id).match, "confirmed");
  if (!info) return null;
  const m = coder.decode("matchState", info.data).inner;
  const status = Object.keys(m.status)[0];
  const game = gameOf(new PublicKey(m.game));
  if (status !== "open" || m.b || !game) return null;
  return { game, entry: Number(m.entry.toString()), opener: new PublicKey(m.a.player).toBase58() };
}

/** The wallet that controls an Account (TesoroAccount: 8-byte discriminator, bump, then the authority). */
async function authorityOf(account: string): Promise<string | null> {
  const info = await connection().getAccountInfo(new PublicKey(account), "confirmed");
  return info && info.data.length >= 41 ? new PublicKey(info.data.subarray(9, 41)).toBase58() : null;
}

/** Emails a Friend notice through the notification settings of the Account it is for. Quiet when email isn't set up. */
async function notify(n: FriendNotice): Promise<void> {
  let deps;
  try {
    deps = notifyDeps();
  } catch {
    return;
  }
  const authority = await authorityOf(n.to);
  if (!authority) return;
  await handleEvent(deps, n.kind === "friend-request" ? { kind: n.kind, id: n.id, authority } : { kind: n.kind, id: n.id, authority, matchId: n.matchId, game: n.game, entry: n.entry });
}

const shared = globalThis as { tesoroFriendsMemory?: MemoryFriendsStore };

/** Supabase when it is configured; in local dev without it, one in-memory store per server process (on globalThis, so every route shares it). */
export function friendsStore(): FriendsStore {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return supabaseFriendsStore;
  if (process.env.NODE_ENV === "production") throw new Error("Friends storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return (shared.tesoroFriendsMemory ??= new MemoryFriendsStore());
}

export const friendsDeps = (): FriendsDeps => ({ store: friendsStore(), openChallenge, notify });
