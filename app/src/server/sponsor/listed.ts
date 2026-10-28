import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);

/**
 * Whether a Game's `GameRecord` lists it now and the deployed build is the approved one (the same rule tesoro_core applies).
 * The anchor coder names decoded fields as the IDL does: snake_case.
 */
export function gameIsListed(recordData: Uint8Array, programData: Uint8Array, nowS: number): boolean {
  if (programData.length < 12) return false;
  const g = coder.decode("GameRecord", Buffer.from(recordData)) as { listed_until: { toString(): string }; approved_slot: { toString(): string } };
  const slot = Buffer.from(programData).readBigUInt64LE(4);
  return BigInt(g.listed_until.toString()) > BigInt(nowS) && BigInt(g.approved_slot.toString()) === slot;
}
