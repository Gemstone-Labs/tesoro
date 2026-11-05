/**
 * Grows every 174-byte `OfferState` to 182 bytes (`grow_offer`, anyone may send it, the payer pays 8 bytes of rent each) right after
 * tesoro_core gains `counted_in` (Railcar ticket 17). The new field is zero: an old Offer's Entry Limit count is not given back.
 * An old Offer still Open reads as is (its unused Player slot holds the zero), but an Accepted one cannot be read until it is
 * grown, by the program or by the keeper's `offerState.all()` decoders, so run this before restarting the keeper. A 182-byte Offer is left alone, so a re-run only touches what is still short.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/grow-offers.ts [--read-rpc <url>]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/grow-offers.ts --send --keypair <payer.json> [--rpc <url>]
 *
 * Dry run (default) lists how many Offers are short and sends nothing. Test mode (devnet) only.
 */
import { ComputeBudgetProgram, Connection, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { CORE, SPACE, coreProgram } from "../src/retire-old.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const send = args.flag("send");
const reader = new Connection(args.value("read-rpc") ?? "https://api.devnet.solana.com", "confirmed");
const sender = new Connection(args.value("rpc") ?? "https://rpc.magicblock.app/devnet", "confirmed");
const PER_TX = 8;

const disc = (name: string) => Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)!.discriminator);

const short = (
  await reader.getProgramAccounts(CORE, {
    filters: [{ dataSize: SPACE.offerV1 }, { memcmp: { offset: 0, bytes: disc("OfferState").toString("base64"), encoding: "base64" } }],
    dataSlice: { offset: 0, length: 0 },
  })
).map((r) => r.pubkey);
console.log(`${short.length} Offers of ${SPACE.offerV1} bytes to grow to ${SPACE.offer}`);
if (!send || !short.length) process.exit(0);

const payer = loadKeypair(args.need("keypair"));
const program = coreProgram();
for (let i = 0; i < short.length; i += PER_TX) {
  const group = short.slice(i, i + PER_TX);
  const ixs = await Promise.all(group.map((offer) => program.methods.growOffer().accountsStrict({ payer: payer.publicKey, offer, systemProgram: SystemProgram.programId }).instruction()));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 15_000 * group.length }), ...ixs);
  console.log(`  ${group.length} grown  ${await sendAndConfirmTransaction(sender, tx, [payer], { commitment: "confirmed" })}`);
}
