import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain, TESORO_CORE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import { HoldemChain, addresses as holdemAddresses } from "@/games/holdem/chain";
import { TradingDuelChain, addresses as duelAddresses } from "@/games/trading-duel/chain";
import { VANGUARD_PROGRAM_ID, addresses as vanguardAddresses } from "@/games/vanguard/chain";
import { decodeBattle } from "@/games/vanguard/decode";
import type { GameId } from "@/lib/mock";
import "@/lib/chain/polyfill";
import blockPuzzleIdl from "@/lib/chain/idl/block_puzzle.json";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import holdemIdl from "@/lib/chain/idl/holdem.json";
import tradingDuelIdl from "@/lib/chain/idl/trading_duel.json";
import { fetchLeaderboardTerms } from "@/lib/chain/leaderboard";
import { baseRpc } from "@/lib/chain/rpc-config";
import { gameOf, toChainMatch } from "@/lib/chain/read";
import { profileFromChain } from "@/lib/identity/codec";
import { winCardData, type WinCardData } from "@/lib/win-card";

/** Raw decoded accounts, each null when it does not exist. */
export interface WinDeps {
  matchState(id: bigint): Promise<any | null>;
  /** The Session of a Block Puzzle Match, or the finished table of a Hold'em or Trading Duel one. */
  gameAccount(id: bigint, game: GameId): Promise<any | null>;
  profile(account: PublicKey): Promise<any | null>;
}

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const settled = (state: any) => Object.keys(state.inner.status)[0] === "settled";

/** The card for a Match, or null when it does not exist or has no winner (open, active, refunded, drawn). */
export async function loadWin(id: bigint, deps: WinDeps = chainDeps()): Promise<WinCardData | null> {
  const state = await deps.matchState(id);
  if (!state || !settled(state)) return null;
  const game = gameOf(pk(state.inner.game));
  if (!game) return null;
  const account = await deps.gameAccount(id, game);
  const m = toChainMatch(state, null, game === "block-puzzle" ? account : null, game === "block-puzzle" ? null : account);
  const winner = m.winner ?? (m.session?.settled ? m.session.result : null);
  const side = winner === "opener" ? m.sides[0] : winner === "joiner" ? m.sides[1] : null;
  const profile = side ? await deps.profile(new PublicKey(side.player)).catch(() => null) : null;
  return winCardData(m, profileFromChain(profile));
}

/** The finished Battle on the base layer; only its winning seat is read. */
async function vanguardBattle(base: Connection, id: bigint): Promise<{ winner: number } | null> {
  const info = await base.getAccountInfo(vanguardAddresses(id).battle).catch(() => null);
  if (!info || !info.owner.equals(VANGUARD_PROGRAM_ID)) return null;
  try {
    return decodeBattle(info.data);
  } catch {
    return null;
  }
}

let conn: Connection | null = null;

function chainDeps(): WinDeps {
  conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" });
  const base = conn;
  const bp = new BlockPuzzleChain({ base, blockPuzzleIdl: blockPuzzleIdl as Idl, coreIdl: coreIdl as Idl });
  const holdem = new HoldemChain(holdemIdl, coreIdl, { base });
  const duel = new TradingDuelChain(tradingDuelIdl, coreIdl, { base });
  return {
    async matchState(id) {
      await fetchLeaderboardTerms(base).catch(() => undefined);
      return bp.core.account.matchState.fetchNullable(BlockPuzzleChain.addresses(id).match);
    },
    gameAccount(id, game) {
      if (game === "holdem") return (holdem.program.account as any).gameMatch.fetchNullable(holdemAddresses(id).gameMatch).catch(() => null);
      if (game === "trading-duel") return (duel.program.account as any).duel.fetchNullable(duelAddresses(id).duel).catch(() => null);
      if (game === "vanguard") return vanguardBattle(base, id);
      return bp.bp.account.session.fetchNullable(BlockPuzzleChain.addresses(id).session).catch(() => null);
    },
    profile: (account) =>
      bp.core.account.profile.fetchNullable(PublicKey.findProgramAddressSync([Buffer.from("profile"), account.toBuffer()], TESORO_CORE_PROGRAM_ID)[0]),
  };
}
