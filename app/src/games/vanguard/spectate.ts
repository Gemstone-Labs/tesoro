/**
 * What anyone may see of a live Vanguard Match: the public Battle only. A spectator has no token and no Army: the
 * one account this module reads is the Battle, so the only ranks on screen are those the Battle published.
 */
import { Connection, type PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC } from "../holdem/chain";
import { VANGUARD_PROGRAM_ID, addresses, type TableRef } from "./chain";
import { decodeBattle, type Battle } from "./decode";
import type { ShownPiece } from "./VanguardBoard";
import { shownPieces } from "./view";

/** Every piece on the board with the US Army at the bottom; face up only where the Battle published a rank. No side's "seen by the enemy" glow: a spectator has no side. */
export const spectatorPieces = (b: Battle): ShownPiece[] => shownPieces(b, null, b.usSeat).map((p) => ({ ...p, exposed: undefined }));

type Reader = Pick<Connection, "getAccountInfo">;

/**
 * The public Battle of a table through the rollup's open endpoint (no token), or null if it is not readable or it belongs to another
 * Match (the Battle is reused by every Match on its table).
 */
export async function readPublicBattle(conn: Reader, ref: TableRef, match: PublicKey): Promise<Battle | null> {
  const key: PublicKey = addresses(ref).battle;
  const info = await conn.getAccountInfo(key);
  if (!info || !(info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
  try {
    const b = decodeBattle(info.data);
    return b.tesoroMatch.equals(match) ? b : null;
  } catch {
    return null;
  }
}

export const publicConnection = (): Connection => new Connection(TEE_RPC, "confirmed");
