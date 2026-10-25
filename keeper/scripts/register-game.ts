/**
 * Registers a Game program in tesoro_core (`register_game`). The key that signs is the program's UPGRADE AUTHORITY, read by
 * tesoro_core from the program's ProgramData (not the admin); it pays the rent. The settle authority is the Game's
 * `["authority"]` PDA. The Studio recipient is the Account of `--studio <wallet>` (it must exist, and may not be the Pool, the
 * Treasury or the Platform recipient), or Config's Platform recipient is refused. Studio Fee is at most 1000 bps.
 * Registering does not list the Game: the admin does that with `--list` (`list_game`, signed by the admin keypair).
 * On mainnet prefer `launch-admin.ts` (prints the whole launch plan).
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/register-game.ts <game program id> <studio_bps> \
 *     --keypair <upgrade authority file> --studio <wallet> [--rpc <url>] [--cluster test|mainnet] [--program tesoro_core=<ID>] [--dry-run]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/register-game.ts <game program id> --list --keypair <admin file> \
 *     [--listed-days 365] [--rpc <url>]     (lists the build deployed now; its hash is computed here and checked again on chain)
 */
import { ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { adminSigning, parseArgs, programOverrides } from "../src/cli-args.ts";
import { codeHash, configPda, coreAccountPda, coreIx, gameAuthorityPda, gameRecordPda, programDataPda } from "../src/launch-admin.ts";

const a = parseArgs(process.argv.slice(2), ["dry-run", "list"]);
const [programArg, bpsArg] = a.positional;
if (!programArg || (!a.flag("list") && bpsArg === undefined)) throw new Error("usage: register-game.ts <game program id> <studio_bps> --keypair <upgrade authority file> --studio <wallet> [--rpc <url>]  |  register-game.ts <game program id> --list --keypair <admin file>");
const game = new PublicKey(programArg);
const { conn: c, keypair: signer, program: core } = await adminSigning(a, programOverrides(a.values("program")));
const record = await c.getAccountInfo(gameRecordPda(core, game));

async function send(ix: ReturnType<typeof coreIx>, what: string) {
  // list_game hashes the whole deployed program: 400,000 to 1,160,000 CU (ticket 10)
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  if (a.flag("dry-run")) {
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx);
    console.log("dry run:", sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
    process.exit(sim.value.err ? 1 : 0);
  }
  console.log(what, await sendAndConfirmTransaction(c, tx, [signer]));
}

if (a.flag("list")) {
  if (!record) throw new Error("the Game is not registered yet");
  const pd = await c.getAccountInfo(programDataPda(game));
  if (!pd || pd.data.length < 12) throw new Error("the program's ProgramData cannot be read");
  const hash = codeHash(pd.data);
  const until = Math.floor(Date.now() / 1000) + Number(a.value("listed-days") ?? 365) * 86_400;
  const ix = coreIx(
    core,
    "list_game",
    { admin: signer.publicKey, game_record: gameRecordPda(core, game), game_program: game, program_data: programDataPda(game) },
    { listed_until: new anchor.BN(until), approved_hash: [...Buffer.from(hash, "hex")] },
  );
  await send(ix, `listed ${game.toBase58()} for build ${hash} until ${new Date(until * 1000).toISOString()}`);
} else {
  const info = await c.getAccountInfo(configPda(core));
  if (!info) throw new Error("Config does not exist: tesoro_core is not initialised on this cluster");
  if (record) {
    console.log("already registered; changes go through propose_game_change (7-day wait)");
  } else {
    if (!a.value("studio")) throw new Error("--studio <wallet> is required: its Account receives the Studio Fee");
    const authority = gameAuthorityPda(game);
    const ix = coreIx(
      core,
      "register_game",
      { payer: signer.publicKey, control: signer.publicKey, game_program: game, program_data: programDataPda(game), studio_recipient: coreAccountPda(core, new PublicKey(a.value("studio")!)) },
      { settle_authority: authority, studio_bps: Number(bpsArg) },
    );
    await send(ix, `registered ${game.toBase58()} settle authority ${authority.toBase58()}`);
  }
}
