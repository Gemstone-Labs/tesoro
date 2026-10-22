import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { codeHash } from "@/lib/listing/hash";
import type { ChainListing, LiveProgram } from "@/lib/listing/state";
import { getChain } from "./client";
import { coreIx } from "./core-ix";
import { gameRecordPda, programDataPda } from "./game-record";
import coreIdl from "./idl/tesoro_core.json";
import { CONFIG, TESORO_CORE_ID } from "./native";

/** `list_game` hashes the whole program on chain (about 0.5 CU a byte, ~400k for the largest Game): ask for the most a transaction may use. */
const LIST_GAME_UNITS = 1_400_000;

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);

/** A Game's listing as the chain holds it, and the program as deployed now. */
export interface GameStanding {
  registered: boolean;
  chain: ChainListing | null;
  live: LiveProgram | null;
}

/** Decodes the listing fields of a GameRecord account. */
export function decodeListing(data: Uint8Array): ChainListing {
  const g = coder.decode("GameRecord", Buffer.from(data)) as { listedUntil: { toString(): string }; approvedSlot: { toString(): string }; approvedHash: number[] | Uint8Array };
  const hash = Buffer.from(g.approvedHash).toString("hex");
  return { listedUntil: Number(g.listedUntil.toString()), approvedSlot: BigInt(g.approvedSlot.toString()), approvedHash: /^0+$/.test(hash) ? null : hash };
}

export async function readStanding(program: PublicKey): Promise<GameStanding> {
  const conn = getChain().base;
  const [record, data] = await Promise.all([conn.getAccountInfo(gameRecordPda(program)), conn.getAccountInfo(programDataPda(program))]);
  const registered = !!record && record.owner.equals(TESORO_CORE_ID);
  return {
    registered,
    chain: registered && record ? decodeListing(record.data) : null,
    live: data && data.data.length > 45 ? { slot: Buffer.from(data.data).readBigUInt64LE(4), hash: await codeHash(data.data) } : null,
  };
}

/** The `list_game` instruction: the admin approves the build deployed right now until `listedUntil`. */
export function listGameIx(admin: PublicKey, program: PublicKey, listedUntil: number, approvedHash: string): TransactionInstruction {
  if (!/^[0-9a-f]{64}$/.test(approvedHash)) throw new Error("The build hash is 64 hex characters.");
  return coreIx(
    "list_game",
    { admin, config: CONFIG, game_record: gameRecordPda(program), game_program: program, program_data: programDataPda(program) },
    { listed_until: BigInt(listedUntil), approved_hash: [...Buffer.from(approvedHash, "hex")] },
  );
}

/**
 * Lists a Game from the admin wallet (which must be tesoro_core's admin): reads the program as deployed now, and approves
 * exactly that build until the end of the paid year. Also the re-approval after the Studio upgrades.
 */
export async function listGame(signer: ChainSigner, program: PublicKey, listedUntil: number): Promise<string> {
  const standing = await readStanding(program);
  if (!standing.registered) throw new Error("This Game is not registered with Tesoro yet. The Studio signs register_game with its upgrade authority first.");
  if (!standing.live) throw new Error("This program has no upgradeable ProgramData to approve.");
  return getChain().sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: LIST_GAME_UNITS }), listGameIx(signer.publicKey, program, listedUntil, standing.live.hash)]);
}
