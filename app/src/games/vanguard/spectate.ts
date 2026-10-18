/**
 * What anyone may see of a live Vanguard Match: the public Battle only. A spectator has no token and no Army: the
 * one account this module reads is the Battle, so the only ranks on screen are those the Battle published.
 */
import { Connection, type PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC } from "../holdem/chain";
import { VANGUARD_PROGRAM_ID, addresses } from "./chain";
import { decodeBattle, type Battle } from "./decode";
import type { ShownPiece } from "./VanguardBoard";
import { shownPieces } from "./view";

/** Every piece on the board with the US Army at the bottom; face up only where the Battle published a rank. */
export const spectatorPieces = (b: Battle): ShownPiece[] => shownPieces(b, null, b.usSeat);

type Reader = Pick<Connection, "getAccountInfo">;

/** The public Battle through the rollup's open endpoint (no token), or null if it is not readable. */
export async function readPublicBattle(conn: Reader, matchId: bigint | number): Promise<Battle | null> {
  const key: PublicKey = addresses(matchId).battle;
  const info = await conn.getAccountInfo(key);
  if (!info || !(info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
  try {
    return decodeBattle(info.data);
  } catch {
    return null;
  }
}

export const publicConnection = (): Connection => new Connection(TEE_RPC, "confirmed");
