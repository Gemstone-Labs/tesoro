import "server-only";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import blockPuzzleIdl from "@/lib/chain/idl/block_puzzle.json";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { fetchSeasonWins } from "@/lib/chain/leaderboard";
import { baseRpc } from "@/lib/chain/rpc-config";
import { batchOffsets, boardTiming } from "@/games/block-puzzle/move-timing";
import type { RunBatches, SeasonInput } from "@/lib/review/flags";

const CORE = new PublicKey(coreIdl.address);
const BLOCK_PUZZLE = new PublicKey(blockPuzzleIdl.address);
/** Matches per Season whose Boards are read: the most recent. Keeps one review to a few RPC calls. */
const MAX_MATCHES_PER_SEASON = 400;

const le8 = (id: string) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(id));
  return b;
};
const pda = (program: PublicKey, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const coreAccountOf = (authority: PublicKey) => pda(CORE, [Buffer.from("account"), authority.toBuffer()]).toBase58();

/** The two Board addresses of a Match. Boards of other games' Matches simply do not exist. */
export function boardAddresses(matchId: string): PublicKey[] {
  const session = pda(BLOCK_PUZZLE, [Buffer.from("session"), pda(CORE, [Buffer.from("match"), le8(matchId)]).toBuffer()]);
  return [0, 1].map((seat) => pda(BLOCK_PUZZLE, [Buffer.from("board"), session.toBuffer(), Buffer.from([seat])]));
}

/**
 * The batch cadence of each Block Puzzle run, from the Boards the programs keep on the base layer.
 * Boards from before the move-timing upgrade carry no slots and are skipped.
 */
async function loadRuns(conn: Connection, matchIds: string[]): Promise<RunBatches[]> {
  const coder = new anchor.BorshAccountsCoder(blockPuzzleIdl as anchor.Idl);
  const runs: RunBatches[] = [];
  for (let i = 0; i < matchIds.length; i += 50) {
    const ids = matchIds.slice(i, i + 50);
    const infos = await conn.getMultipleAccountsInfo(ids.flatMap(boardAddresses), "confirmed");
    infos.forEach((info, k) => {
      if (!info) return;
      try {
        const board: any = coder.decode("Board", Buffer.from(info.data));
        if (!board.moveSlots) return;
        const batches = batchOffsets(boardTiming(board));
        runs.push({ matchId: ids[k >> 1], account: coreAccountOf(new PublicKey(board.player)), batches });
      } catch {
        // an account that is not a Board (or an older layout): nothing to judge
      }
    });
  }
  return runs;
}

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

/** Public chain reads for the given Seasons: their wins and the Block Puzzle runs of those Matches. */
export async function loadSeasons(seasons: number[]): Promise<SeasonInput[]> {
  const c = connection();
  return Promise.all(
    seasons.map(async (season) => {
      const wins = await fetchSeasonWins(c, season);
      const recent = [...wins].sort((a, b) => b.ts - a.ts).slice(0, MAX_MATCHES_PER_SEASON).map((w) => w.matchId);
      return { season, wins, runs: await loadRuns(c, recent) };
    }),
  );
}
