/**
 * Registers a Game program in tesoro_core (`register_game`, admin only) with its `["authority"]`
 * PDA as the settlement authority, and approves the TEE validator for its delegations.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/register-game.ts <program id> <studio_bps>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };

const rpc = process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet";
const [programArg, bpsArg] = process.argv.slice(2);
const game = new PublicKey(programArg);
const studioBps = Number(bpsArg);
const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const c = new Connection(rpc, "confirmed");
const provider = new AnchorProvider(c, { publicKey: admin.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t }, {});
const core = new Program(coreIdl as any, provider);
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0];
const authority = PublicKey.findProgramAddressSync([Buffer.from("authority")], game)[0];
const cfg: any = core.coder.accounts.decode("config", (await c.getAccountInfo(config))!.data);
const entry = cfg.games.find((g: any) => g.game.equals(game));
if (entry && entry.authority.equals(authority)) {
  console.log("already registered", authority.toBase58());
} else {
  const ix = await core.methods
    .registerGame(game, authority, studioBps)
    .accountsPartial({ admin: admin.publicKey, config, studioRecipient: cfg.platformRecipient } as any)
    .instruction();
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin]);
  console.log("registered", game.toBase58(), "authority", authority.toBase58(), sig);
}
