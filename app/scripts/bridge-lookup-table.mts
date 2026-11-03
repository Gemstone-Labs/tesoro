/**
 * The bridge's address lookup table (keeper diet ticket 15): the addresses every Player's bridge transaction shares, so an Unlock
 * or Redeem with its LayerZero send fits one packet. The sponsor compiles with it (TESORO_SPONSOR_LOOKUP_TABLES takes a list: add this
 * table's address after the existing one). Creating or extending it is an orchestrator step; `plan` and `sizes` only read.
 *
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/bridge-lookup-table.mts plan
 *       print the addresses (the stable ones of every listed vault, from the live LayerZero send accounts)
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/bridge-lookup-table.mts sizes
 *       compile each bundle against a table holding those addresses and print its size in bytes (limit 1232)
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/bridge-lookup-table.mts create <keyfile.json>
 *       create the table and add the addresses (the key pays and becomes the authority)
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/bridge-lookup-table.mts extend <keyfile.json> <table>
 *       add the addresses the table lacks (run it again after a new vault is listed or a LayerZero library changes)
 *
 * Devnet unless SOLANA_RPC says otherwise. Run `plan` first; `create` and `extend` print what they will do and then send.
 */
import { readFileSync } from "node:fs";
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2/umi";

const RPC = process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";
const conn = new Connection(RPC, "confirmed");

const bundle = await import("@/lib/chain/bridge-bundle");
const steps = await import("@/lib/chain/bridge-steps");
const eth = await import("@/lib/chain/eth");
const native = await import("@/lib/chain/native");

/** The relayer stands in as the payer; the table never holds it (it signs), so any key will do for planning. */
const stand = Keypair.generate();

async function quoteOf(vault: string): Promise<import("@/lib/chain/bridge-bundle").SendQuote> {
  const umi = createUmi(RPC);
  umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(stand))));
  const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID);
  const oapp = umiKey(eth.bridgeStore().toBase58());
  const eid = eth.netOfVault(vault).eid;
  const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid);
  if (!lib.programId) throw new Error(`no send library for ${vault}`);
  const receiver = Uint8Array.from(Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"));
  const path = { dstEid: eid, sender: oapp, receiver };
  const sendMetas = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram: new UlnProgram.Uln(lib.programId) });
  return {
    endpointSettings: toWeb3JsPublicKey(endpoint.pda.setting()[0]).toBase58(),
    payer: stand.publicKey.toBase58(),
    send: sendMetas!.map((m) => ({ pubkey: toWeb3JsPublicKey(m.pubkey).toBase58(), signer: m.isSigner, writable: m.isWritable })),
    feeLamports: "350000",
  };
}

const vaults = eth.ETH_VAULTS.map((v) => v.address as string);
const quotes = new Map<string, import("@/lib/chain/bridge-bundle").SendQuote>();
for (const v of vaults) quotes.set(v, await quoteOf(v));

const addresses = () => [...new Map(vaults.flatMap((v) => bundle.stableBridgeAddresses(v, quotes.get(v)!)).map((a) => [a.toBase58(), a])).values()];
const key = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

async function sendTx(payer: Keypair, ...ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Each bundle as the sponsor compiles it for a Player with a long Advance (a book and three pages), measured against a table of `addrs`. */
function sizes(addrs: PublicKey[]) {
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: stand.publicKey, addresses: addrs } });
  const player = Keypair.generate().publicKey;
  const rnd = () => Keypair.generate().publicKey;
  const rows: [string, number][] = [];
  for (const vault of vaults) {
    const id = 7n;
    const position = eth.corePositionPda(eth.ethPositionId(vault, id));
    const source = native.sourcePda(position, 0);
    const quote = quotes.get(vault)!;
    const books = [rnd(), rnd(), rnd(), rnd()];
    const yieldPlan = { openAdvance: 0, books, create: [] };
    const line = { side: 0, dueAt: 0n, class: 0, tranche: 0 };
    const measure = (groups: ReturnType<typeof steps.unlockGroups>) => {
      const message = new TransactionMessage({
        payerKey: stand.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...groups.flat()],
      }).compileToV0Message([table]);
      return new VersionedTransaction(message).serialize().length;
    };
    const base = { payer: stand.publicKey, sponsored: true, player, vault, id, position };
    const label = `${eth.netOfVault(vault).label}`;
    rows.push([`${label}: Unlock + send (Advance open, pages ${books.length - 1})`, measure(steps.unlockGroups({ ...base, open: { index: 0, accounts: books, create: [] }, applyYield: null, quote }))]);
    rows.push([`${label}: apply_yield + Unlock + send`, measure(steps.unlockGroups({ ...base, open: { index: 0, accounts: books, create: [] }, applyYield: yieldPlan, quote }))]);
    const redeem = { ...base, source, sourceIndex: 0, gemas: 5n, target: { line, accounts: books }, create: [], holderEvm: "0x" + "ab".repeat(20), playerLamports: 0n, quote };
    rows.push([`${label}: Redeem + send (Claim exists)`, measure(steps.redeemGroups({ ...redeem, claimExists: true, applyYield: null }))]);
    rows.push([`${label}: rent + apply_yield + Redeem + send (0 SOL, no Claim)`, measure(steps.redeemGroups({ ...redeem, claimExists: false, applyYield: yieldPlan }))]);
  }
  return rows;
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "plan") {
  for (const k of addresses()) console.log(k.toBase58());
  console.error(`${addresses().length} addresses for ${vaults.length} vaults`);
} else if (mode === "sizes") {
  for (const [name, n] of sizes(addresses())) console.log(`${String(n).padStart(5)} B  ${n <= 1232 ? "fits " : "OVER "} ${name}`);
  console.log(`(packet limit 1232 B; table of ${addresses().length} addresses)`);
} else if (mode === "create") {
  const payer = key(a);
  const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: await conn.getSlot("finalized") });
  console.log("create", table.toBase58(), await sendTx(payer, ix));
  const list = addresses();
  for (let i = 0; i < list.length; i += 20) console.log("extend", await sendTx(payer, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: list.slice(i, i + 20) })));
  console.log(`add ${table.toBase58()} to TESORO_SPONSOR_LOOKUP_TABLES`);
} else if (mode === "extend") {
  const payer = key(a);
  const table = new PublicKey(b);
  const have = new Set(((await conn.getAddressLookupTable(table)).value?.state.addresses ?? []).map((k) => k.toBase58()));
  const missing = addresses().filter((k) => !have.has(k.toBase58()));
  console.log(`${missing.length} missing`);
  for (let i = 0; i < missing.length; i += 20) console.log("extend", await sendTx(payer, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: missing.slice(i, i + 20) })));
} else {
  throw new Error("usage: bridge-lookup-table.mts plan | sizes | create <keyfile> | extend <keyfile> <table>");
}
process.exit(0);
