/**
 * F-01 operational step: approves ONLY the TEE validator for a Game program in MagicBlock's delegation
 * program (`whitelist_validator_for_program`, signed by the program's upgrade authority). Once a program
 * has a ProgramConfig, the delegation program refuses to delegate its accounts to any validator outside
 * `approved_validators`. Prints the resulting config.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/whitelist-tee.ts <program id> [--remove <validator>]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TEE = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const rpc = process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet";

const [programArg, flag, other] = process.argv.slice(2);
const program = new PublicKey(programArg);
const validator = flag === "--remove" ? new PublicKey(other) : TEE;
const insert = flag !== "--remove";
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"))));
const c = new Connection(rpc, "confirmed");

const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
const dlpData = PublicKey.findProgramAddressSync([DLP.toBuffer()], LOADER)[0];
const config = PublicKey.findProgramAddressSync([Buffer.from("p-conf"), program.toBuffer()], DLP)[0];
const disc = Buffer.alloc(8);
disc.writeBigUInt64LE(8n);
const ix = new TransactionInstruction({
  programId: DLP,
  keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: validator, isSigner: false, isWritable: false },
    { pubkey: program, isSigner: false, isWritable: false },
    { pubkey: programData, isSigner: false, isWritable: false },
    { pubkey: dlpData, isSigner: false, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc, Buffer.from([insert ? 1 : 0])]),
});
const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [authority]);
console.log(`${insert ? "approved" : "removed"} ${validator.toBase58()} for ${program.toBase58()}: ${sig}`);
const info = await c.getAccountInfo(config, "confirmed");
if (info) {
  // ProgramConfig: 8-byte discriminator, borsh BTreeSet<Pubkey> (u32 length, 32-byte keys).
  const n = info.data.readUInt32LE(8);
  const keys = Array.from({ length: n }, (_, i) => new PublicKey(info.data.subarray(12 + 32 * i, 44 + 32 * i)).toBase58());
  console.log(`ProgramConfig ${config.toBase58()} approved_validators:`, keys);
}
