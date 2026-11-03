import bs58 from "bs58";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import type { RawTx } from "../history/webhook";

const CORE = (coreIdl as { address: string }).address;
type IdlInstruction = { name: string; discriminator: number[]; accounts: { name: string }[] };
const instructions = (coreIdl as unknown as { instructions: IdlInstruction[] }).instructions;
const byDiscriminator = new Map(instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), i]));

/** One tesoro_core instruction of a transaction, top level or run by another program. */
export interface CoreInstruction {
  name: string;
  /** Account keys in instruction order. */
  accounts: string[];
  /** The arguments: instruction data after the 8-byte discriminator. */
  data: Buffer;
  /** The key given for the account called `name` in the IDL; undefined when the instruction has fewer accounts. */
  account(name: string): string | undefined;
}

/**
 * Every tesoro_core instruction in execution order: each top-level instruction, then the ones it ran. Only instructions of
 * tesoro_core count (a game's CPI into core is one); an unknown discriminator is skipped.
 */
export function coreInstructionsOf(tx: RawTx): CoreInstruction[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  type Raw = { programIdIndex: number; accounts: number[]; data: string };
  const ordered: Raw[] = [];
  (tx.transaction.message.instructions ?? []).forEach((ix, index) => {
    ordered.push(ix);
    for (const group of tx.meta?.innerInstructions ?? []) if (group.index === index) ordered.push(...group.instructions);
  });
  const top = tx.transaction.message.instructions?.length ?? 0;
  for (const group of tx.meta.innerInstructions ?? []) if (group.index === undefined || group.index >= top) ordered.push(...group.instructions);
  const out: CoreInstruction[] = [];
  for (const ix of ordered) {
    if (keys[ix.programIdIndex] !== CORE) continue;
    const data = Buffer.from(bs58.decode(ix.data));
    const def = byDiscriminator.get(data.subarray(0, 8).toString("hex"));
    if (!def) continue;
    const accounts = ix.accounts.map((a) => keys[a]);
    out.push({ name: def.name, accounts, data: data.subarray(8), account: (name) => accounts[def.accounts.findIndex((a) => a.name === name)] });
  }
  return out;
}
