import { PublicKey, SystemProgram } from "@solana/web3.js";
import blockPuzzleIdl from "@/lib/chain/idl/block_puzzle.json";
import holdemIdl from "@/lib/chain/idl/holdem.json";
import tradingDuelIdl from "@/lib/chain/idl/trading_duel.json";
import vanguardIdl from "@/lib/chain/idl/vanguard.json";
import { settledPda } from "@/lib/chain/basket";
import { gameRecordPda, programDataPda } from "@/lib/chain/game-record";
import { TESORO_CORE_ID } from "@/lib/chain/native";

/** The Game instructions the relayer may send as `caller` (see GAME_STEPS in rules.ts). */
export type StepName = "finalize" | "refund_untabled" | "close_assignment";

interface Slot {
  name: string;
  writable: boolean;
  signer: boolean;
}
interface IdlLike {
  address: string;
  instructions: { name: string; accounts: { name: string; writable?: boolean; signer?: boolean }[] }[];
}

const STEP_NAMES: StepName[] = ["finalize", "refund_untabled", "close_assignment"];
/** Per Game program: the exact account list of each step, with the IDL's signer and writable flags. */
const LAYOUTS = new Map<string, Record<StepName, Slot[]>>();
for (const idl of [blockPuzzleIdl, holdemIdl, tradingDuelIdl, vanguardIdl] as IdlLike[]) {
  const steps = {} as Record<StepName, Slot[]>;
  for (const n of STEP_NAMES) {
    const ix = idl.instructions.find((i) => i.name === n);
    if (!ix) throw new Error(`${idl.address} has no ${n}`);
    steps[n] = ix.accounts.map((a) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer }));
  }
  LAYOUTS.set(idl.address, steps);
}

export const knownGame = (program: PublicKey) => LAYOUTS.has(program.toBase58());

const eventAuthority = (program: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program)[0];

/**
 * What every account of `step` must be, from the Game, the relayer and the Match alone. A null key is left to the program
 * (the table, which only the Assignment's contents name; the operator `payer`, which close_assignment checks against the
 * Assignment). Returns null when the program is not a Game we know or the Match is not in the list yet.
 */
export function stepSlots(program: PublicKey, step: StepName, matchAt: number, keys: PublicKey[], relayer: PublicKey): { slot: Slot; expect: PublicKey | null }[] | null {
  const layout = LAYOUTS.get(program.toBase58())?.[step];
  if (!layout || keys.length !== layout.length) return null;
  const match = keys[matchAt];
  const hasCoreAuthority = layout.some((s) => s.name === "core_event_authority");
  const derive = (name: string): PublicKey | null => {
    switch (name) {
      case "caller": return relayer;
      case "assignment": return PublicKey.findProgramAddressSync([Buffer.from("assign"), match.toBuffer()], program)[0];
      case "tesoro_match":
      case "match_state": return match;
      case "config": return PublicKey.findProgramAddressSync([Buffer.from("config")], TESORO_CORE_ID)[0];
      case "game_record": return gameRecordPda(program);
      case "authority": return PublicKey.findProgramAddressSync([Buffer.from("authority")], program)[0];
      case "game_program":
      case "program": return program;
      case "program_data": return programDataPda(program);
      case "receipt": return settledPda(match);
      case "system_program": return SystemProgram.programId;
      case "core_event_authority": return eventAuthority(TESORO_CORE_ID);
      case "event_authority": return hasCoreAuthority ? eventAuthority(program) : eventAuthority(TESORO_CORE_ID);
      case "tesoro_program": return TESORO_CORE_ID;
      case "table":
      case "payer": return null;
      default: throw new Error(`unmapped Game step account ${name}`);
    }
  };
  return layout.map((slot) => ({ slot, expect: derive(slot.name) }));
}

/** The index of the tesoro_core Match in the account list of a step. */
export const matchIndexOf = (program: PublicKey, step: StepName): number => (LAYOUTS.get(program.toBase58())?.[step] ?? []).findIndex((s) => s.name === "tesoro_match" || s.name === "match_state");

/** How many accounts `step` takes in `program` (0 when unknown). */
export const stepKeyCount = (program: PublicKey, step: StepName): number => LAYOUTS.get(program.toBase58())?.[step].length ?? 0;
