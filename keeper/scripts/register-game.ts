/**
 * Registers a Game program in tesoro_core (`register_game`, admin only) with its `["authority"]` PDA as the settlement
 * authority. The Studio recipient is the Account of `--studio <wallet>` (it must exist), or Config's Platform recipient
 * without it. On mainnet prefer `launch-admin.ts` (prints the whole launch plan).
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/register-game.ts <game program id> <studio_bps> \
 *     --keypair <admin file> [--rpc <url>] [--cluster test|mainnet] [--program tesoro_core=<ID>] [--studio <wallet>] [--dry-run]
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { adminSigning, parseArgs, programOverrides } from "../src/cli-args.ts";
import { configPda, coreAccountPda, coreIx, gameAuthorityPda } from "../src/launch-admin.ts";

const a = parseArgs(process.argv.slice(2), ["dry-run"]);
const [programArg, bpsArg] = a.positional;
if (!programArg || bpsArg === undefined) throw new Error("usage: register-game.ts <game program id> <studio_bps> --keypair <file> [--rpc <url>]");
const game = new PublicKey(programArg);
const studioBps = Number(bpsArg);
const { conn: c, keypair: admin, program: core } = await adminSigning(a, programOverrides(a.values("program")));

const authority = gameAuthorityPda(game);
const info = await c.getAccountInfo(configPda(core));
if (!info) throw new Error("Config does not exist: tesoro_core is not initialised on this cluster");
const cfg: any = new anchor.BorshAccountsCoder(coreIdl as any).decode("config", info.data);
const entry = cfg.games.find((g: any) => g.game.equals(game));
if (entry && entry.authority.equals(authority)) {
  console.log("already registered", authority.toBase58());
} else {
  const studio = a.value("studio") ? coreAccountPda(core, new PublicKey(a.value("studio")!)) : cfg.platformRecipient;
  const ix = coreIx(core, "register_game", { admin: admin.publicKey, studio_recipient: studio }, { game, authority, studio_bps: studioBps });
  const tx = new Transaction().add(ix);
  if (a.flag("dry-run")) {
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx);
    console.log("dry run:", sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
    process.exit(sim.value.err ? 1 : 0);
  }
  console.log("registered", game.toBase58(), "authority", authority.toBase58(), await sendAndConfirmTransaction(c, tx, [admin]));
}
