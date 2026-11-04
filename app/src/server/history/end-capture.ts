import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TABLE_PHASE as BURST_PHASE, decodeTable as decodeBurstTable } from "../../games/block-puzzle/live-chain";
import { TABLE_PHASE, decodeTable as decodeHoldemTable } from "../../games/holdem/chain";
import { decodeTable as decodeDuelTable } from "../../games/trading-duel/chain";
import { battlePda, decodeTable as decodeVanguardTable } from "../../games/vanguard/chain";
import { STATUS as BATTLE_STATUS, decodeBattle } from "../../games/vanguard/decode";
import { gameOfProgram } from "../../lib/chain/games";
import { matchPda } from "../../lib/chain/basket";
import blockPuzzleIdl from "../../lib/chain/idl/block_puzzle.json";
import holdemIdl from "../../lib/chain/idl/holdem.json";
import duelIdl from "../../lib/chain/idl/trading_duel.json";
import vanguardIdl from "../../lib/chain/idl/vanguard.json";
import { burstEndState, duelEndState, holdemEndState, vanguardEndState } from "./end-boards";
import { endStateOf, recordEndMissing, recordEndState, type EndState } from "./end-state";
import { innerOfRawTx, type StoredTx } from "./webhook";
import { decodeMatchRecords, type InnerInstruction } from "./events";
import type { Rpc } from "./rpc";
import bs58 from "bs58";

/**
 * The final board of a settled table Match, kept in the Match history when the settlement arrives.
 *
 * WHEN: a Game's `finalize` (the base transaction that settles a table Match) names the Table in its accounts. Finalize needs the Match's
 * result committed to base, so base's copy of the Table already holds the final board, and it keeps holding it until a later Match's commit
 * replaces it. That is no sooner than the next `begin_match`, which resets only after `over_at` + 30 s. Reading on delivery (seconds after
 * finalize) therefore comes well before any reset; reading later (catch-up) still works until a later commit lands.
 * TRUST: a board is kept only when base's Table names this very Match (`tesoro_match`, cleared by every reset and set by every begin) and is
 * Over, and for Vanguard the Battle names it too and is Over. Anything else is marked missing, never guessed; a later capture replaces a marker.
 * The read is pinned to the finalize's slot (`minContextSlot`) so a lagging node cannot hand back an older Table.
 */

const FINALIZE = Buffer.from([171, 61, 218, 56, 127, 115, 12, 217]);
type Game = "holdem" | "trading-duel" | "block-puzzle" | "vanguard";

/** Account data of an address on base at or after `minSlot`; null when the account does not exist. Throws when the read fails. */
export interface BaseReader {
  read(address: string, minSlot: number): Promise<Uint8Array | null>;
}

export const connectionBaseReader = (connection: Connection): BaseReader => ({
  read: async (address, minSlot) => {
    const info = await connection.getAccountInfo(new PublicKey(address), { commitment: "confirmed", minContextSlot: minSlot });
    return info ? info.data : null;
  },
});

export interface CaptureDeps {
  rpc: Rpc;
  base: BaseReader;
  /** The last attempt there will be: a failed read is then marked missing instead of reported as an error. */
  lastTry?: boolean;
  warn?: (message: string) => void;
}

export type CaptureOutcome = { match: string; game: Game; outcome: "captured" | "already" | "missing" | "error"; reason?: string };

const programs = new Map<Game, Program>();
const coderOf = (game: Game) => {
  let p = programs.get(game);
  if (!p) {
    const idl = { holdem: holdemIdl, "trading-duel": duelIdl, "block-puzzle": blockPuzzleIdl, vanguard: vanguardIdl }[game];
    p = new Program(idl as never, { connection: {} } as never);
    programs.set(game, p);
  }
  return p.coder.accounts;
};

interface Finalize {
  game: Game;
  table: string;
  match: string;
}

/** The Game finalizes in a transaction, as outer or inner (CPI) instructions. */
function finalizesOf(tx: StoredTx): Finalize[] {
  const m = tx.body.transaction.message;
  const keys = [...m.accountKeys, ...(tx.body.meta?.loadedAddresses?.writable ?? []), ...(tx.body.meta?.loadedAddresses?.readonly ?? [])];
  const outer: InnerInstruction[] = (m.instructions ?? []).map((i) => ({ programId: keys[i.programIdIndex], accounts: i.accounts.map((a) => keys[a]), data: bs58.decode(i.data) }));
  const out: Finalize[] = [];
  for (const i of [...outer, ...innerOfRawTx(tx.body)]) {
    const game = gameOfProgram(new PublicKey(i.programId));
    if (!game || i.data.length < 8 || !Buffer.from(i.data.subarray(0, 8)).equals(FINALIZE) || i.accounts.length < 4) continue;
    out.push({ game, table: i.accounts[2], match: i.accounts[3] });
  }
  return out;
}

/** The core Match addresses of the win and draw records in a transaction. */
function ranMatches(tx: StoredTx): Set<string> {
  const records = decodeMatchRecords(innerOfRawTx(tx.body));
  return new Set(records.flatMap((r) => (r.type === "start" && (r.kind === 0 || r.kind === 2) ? [matchPda(new PublicKey(r.opener), r.n).toBase58()] : [])));
}

class Missing extends Error {}

async function boardOf(deps: CaptureDeps, f: Finalize, slot: number): Promise<{ epoch: number; state: EndState }> {
  const data = await deps.base.read(f.table, slot);
  if (!data) throw new Missing("the Table is not on base");
  const address = new PublicKey(f.table);
  const raw = coderOf(f.game).decode("table", Buffer.from(data));
  const match = new PublicKey(f.match);
  let state: EndState | null;
  let epoch: number;
  switch (f.game) {
    case "holdem": {
      const t = decodeHoldemTable(address, raw);
      if (!t.tesoroMatch.equals(match)) throw new Missing("base's Table belongs to a later Match");
      if (t.phase !== TABLE_PHASE.over) throw new Missing("the Table is not Over on base");
      [state, epoch] = [holdemEndState(t), t.epoch];
      break;
    }
    case "trading-duel": {
      const t = decodeDuelTable(address, raw);
      if (!t.tesoroMatch.equals(match)) throw new Missing("base's Table belongs to a later Match");
      if (t.phase !== TABLE_PHASE.over) throw new Missing("the Table is not Over on base");
      [state, epoch] = [duelEndState(t), t.epoch];
      break;
    }
    case "block-puzzle": {
      const t = decodeBurstTable(address, raw);
      if (!t.tesoroMatch.equals(match)) throw new Missing("base's Table belongs to a later Match");
      if (t.phase !== BURST_PHASE.closed) throw new Missing("the Table is not closed on base");
      [state, epoch] = [burstEndState(t), t.epoch];
      break;
    }
    case "vanguard": {
      const t = decodeVanguardTable(address, raw);
      if (!t.tesoroMatch.equals(match)) throw new Missing("base's Table belongs to a later Match");
      if (t.phase !== TABLE_PHASE.over) throw new Missing("the Table is not Over on base");
      const bytes = await deps.base.read(battlePda(address).toBase58(), slot);
      if (!bytes) throw new Missing("the Battle is not on base");
      const b = decodeBattle(bytes);
      if (!b.tesoroMatch.equals(match) || b.status !== BATTLE_STATUS.over) throw new Missing("base's Battle is not this Match's finished Battle");
      [state, epoch] = [vanguardEndState(b), t.epoch];
      break;
    }
  }
  if (!state) throw new Missing("the Match never started: no board");
  return { epoch, state };
}

/**
 * Keeps the final board of every table Match this transaction settles as a win or draw. Safe to repeat: a stored board is never read again,
 * and a marker is replaced by a later board. A read that fails is reported (`error`) and writes nothing, unless `lastTry`.
 */
export async function captureEndStates(deps: CaptureDeps, tx: StoredTx): Promise<CaptureOutcome[]> {
  const finalizes = finalizesOf(tx);
  if (!finalizes.length) return [];
  const ran = ranMatches(tx);
  const out: CaptureOutcome[] = [];
  for (const f of finalizes) {
    if (!ran.has(f.match)) continue;
    const done = (outcome: CaptureOutcome["outcome"], reason?: string) => out.push(reason ? { match: f.match, game: f.game, outcome, reason } : { match: f.match, game: f.game, outcome });
    try {
      if (await endStateOf(deps.rpc, f.match)) {
        done("already");
        continue;
      }
      const { epoch, state } = await boardOf(deps, f, tx.slot);
      await recordEndState(deps.rpc, f.match, epoch, state);
      done("captured");
    } catch (e) {
      const reason = String((e as Error).message ?? e).split("\n")[0].slice(0, 200);
      if (e instanceof Missing || deps.lastTry) {
        await recordEndMissing(deps.rpc, f.match, f.game, reason).catch((w) => deps.warn?.(`end-state marker for ${f.match}: ${String(w)}`));
        done("missing", reason);
      } else {
        deps.warn?.(`end state of ${f.match} not captured: ${reason}`);
        done("error", reason);
      }
    }
  }
  return out;
}

