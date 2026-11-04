/**
 * Grows every 25-byte `["counters", account]` account to 33 bytes (`migrate_counters`, admin only) right after tesoro_core gains
 * `next_ticket`: the new field starts at 2^63, above every Ticket or Pot nonce an old client chose, so no old address can be made
 * again. A 33-byte account is left alone, so a re-run only touches what is still short. This is the bulk sweep: any
 * transaction that reads an old account already carries `grow_counters` (anyone may send it; the sponsor and the app put it in
 * front), so no Player waits for this script.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-counters.ts [--read-rpc <url>]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-counters.ts --send --keypair ~/.config/solana/dev-2026-10.json [--rpc <url>]
 *
 * Dry run (default) lists how many counters are short and sends nothing. The counters hold no pointer to their Account, so the
 * script lists the program's Accounts and derives each counters address. Test mode (devnet) only.
 */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { CORE, coreProgram } from "../src/retire-old.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const send = args.flag("send");
const reader = new Connection(args.value("read-rpc") ?? "https://api.devnet.solana.com", "confirmed");
const sender = new Connection(args.value("rpc") ?? "https://rpc.magicblock.app/devnet", "confirmed");
const PER_TX = 8;
const SHORT = 25;

const disc = (name: string) => Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)!.discriminator);

const accounts = (
  await reader.getProgramAccounts(CORE, { filters: [{ memcmp: { offset: 0, bytes: disc("TesoroAccount").toString("base64"), encoding: "base64" } }], dataSlice: { offset: 0, length: 0 } })
).map((r) => r.pubkey);
const counters = accounts.map((a) => [a, PublicKey.findProgramAddressSync([Buffer.from("counters"), a.toBuffer()], CORE)[0]] as const);
const short: (readonly [PublicKey, PublicKey])[] = [];
for (let i = 0; i < counters.length; i += 100) {
  const group = counters.slice(i, i + 100);
  const infos = await reader.getMultipleAccountsInfo(group.map(([, c]) => c));
  group.forEach((pair, j) => {
    if (infos[j]?.data.length === SHORT) short.push(pair);
  });
}
console.log(`${accounts.length} Accounts, ${short.length} with 25-byte counters`);
if (!send || !short.length) process.exit(0);

const admin = loadKeypair(args.need("keypair"));
const program = coreProgram();
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0];
for (let i = 0; i < short.length; i += PER_TX) {
  const group = short.slice(i, i + PER_TX);
  const ixs = await Promise.all(
    group.map(([account, c]) => program.methods.migrateCounters().accountsStrict({ admin: admin.publicKey, config, account, counters: c, systemProgram: PublicKey.default }).instruction()),
  );
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 * group.length }), ...ixs);
  console.log(`  ${group.length} migrated  ${await sendAndConfirmTransaction(sender, tx, [admin], { commitment: "confirmed" })}`);
}
