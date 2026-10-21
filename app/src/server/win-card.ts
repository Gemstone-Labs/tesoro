import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain, TESORO_CORE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import "@/lib/chain/polyfill";
import blockPuzzleIdl from "@/lib/chain/idl/block_puzzle.json";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { baseRpc } from "@/lib/chain/rpc-config";
import { profileFromChain } from "@/lib/identity/codec";
import { winCardFromRow, type WinCardData } from "@/lib/win-card";
import { supabaseRpc } from "@/server/history/db";
import type { MatchKey } from "@/server/history/match-key";
import { winCard as readWinCard, type WinCard } from "@/server/history/reads";

/** What the card needs: the settled Match with a winner from the Match history, and the winner's Profile account. */
export interface WinDeps {
  card(id: MatchKey): Promise<WinCard | null>;
  profile(account: PublicKey): Promise<any | null>;
}

/**
 * The card for a Match, or null when it is unknown, unsettled or has no winner (open, active, refunded, drawn).
 * A settled Match's account is closed, so its result is the Match history's (`win_card`), not the chain's.
 */
export async function loadWin(id: MatchKey, deps: WinDeps = chainDeps()): Promise<WinCardData | null> {
  const card = await deps.card(id).catch(() => null);
  if (!card) return null;
  const profile = await deps.profile(new PublicKey(card.winner)).catch(() => null);
  return winCardFromRow(card, profileFromChain(profile));
}

let conn: Connection | null = null;

function chainDeps(): WinDeps {
  conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" });
  const core = new BlockPuzzleChain({ base: conn, blockPuzzleIdl: blockPuzzleIdl as Idl, coreIdl: coreIdl as Idl }).core;
  return {
    card: (id) => readWinCard(supabaseRpc, id),
    profile: (account) => core.account.profile.fetchNullable(PublicKey.findProgramAddressSync([Buffer.from("profile"), account.toBuffer()], TESORO_CORE_PROGRAM_ID)[0]),
  };
}
