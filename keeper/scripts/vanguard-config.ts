/**
 * Sets the Vanguard program's config: the TEE validator its Battles delegate to and the VRF oracle queue that draws
 * the deal (`set_config`, signed by the program's upgrade authority). Run once after a deploy, before any
 * `create_match`; running it again overwrites both values.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/vanguard-config.ts <vanguard program id> --keypair <upgrade authority file> \
 *     [--rpc <url>] [--cluster test|mainnet] [--validator <TEE validator>] [--oracle-queue <queue>] [--dry-run]
 *
 * `--validator` defaults to the cluster's TEE validator; `--oracle-queue` to MagicBlock's devnet VRF queue (the one
 * Hold'em and Block Burst use), so it is required on mainnet.
 */
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import vanguardIdl from "../../app/src/lib/chain/idl/vanguard.json" with { type: "json" };
import { adminSigning, parseArgs } from "../src/cli-args.ts";

const DEVNET_VRF_QUEUE = "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const a = parseArgs(process.argv.slice(2), ["dry-run"]);
const [programArg] = a.positional;
if (!programArg) throw new Error("usage: vanguard-config.ts <vanguard program id> --keypair <upgrade authority file> [--rpc <url>]");
const program = new PublicKey(programArg);
const { cluster, keypair: authority, conn } = await adminSigning(a);
const validator = new PublicKey(a.value("validator") ?? cluster.magicblock.teeValidator);
const queueArg = a.value("oracle-queue") ?? (a.value("cluster") === "mainnet" ? undefined : DEVNET_VRF_QUEUE);
if (!queueArg) throw new Error("--oracle-queue is required on mainnet");
const queue = new PublicKey(queueArg);

const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
const vg = new anchor.Program({ ...(vanguardIdl as any), address: program.toBase58() }, new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {}));
const ix = await vg.methods
  .setConfig(validator, queue)
  .accountsPartial({ authority: authority.publicKey, config, program, programData, systemProgram: SystemProgram.programId })
  .instruction();
const tx = new Transaction().add(ix);

if (a.flag("dry-run")) {
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx);
  console.log("dry run:", sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
  process.exit(sim.value.err ? 1 : 0);
}
const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, [authority]);
const cfg: any = await (vg.account as any).vanguardConfig.fetch(config);
console.log(`config ${config.toBase58()}: tee ${cfg.teeValidator.toBase58()}, oracle queue ${cfg.oracleQueue.toBase58()} (${sig})`);
