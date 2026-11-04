// Creates or extends the address lookup table the sponsor server compiles with (TESORO_SPONSOR_LOOKUP_TABLES). It is optional:
// join + assign fits a plain v0 transaction (kd-02 measurements); the table saves about 28 to 100 bytes.
//   node scripts/sponsor-lookup-table.mjs plan   <operatorAddress> [relayerAddress]            print the addresses, send nothing
//   node scripts/sponsor-lookup-table.mjs create <keyfile.json> <operatorAddress> [relayer]    create a table with them (orchestrator step)
//   node scripts/sponsor-lookup-table.mjs extend <keyfile.json> <table> <operatorAddress> [relayer]  add the ones it lacks
// Devnet unless SOLANA_RPC says otherwise. The keyfile pays and is the table's authority.
import { readFileSync } from "node:fs";
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";
const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const GAMES = {
  "block-puzzle": ["5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj", "config"],
  holdem: ["CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE", "config"],
  vanguard: ["TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH", "tables"],
};

function addresses(operator, relayer) {
  const out = [CORE, SystemProgram.programId, new PublicKey(operator)];
  if (relayer) out.push(new PublicKey(relayer));
  for (const [id, config] of Object.values(GAMES)) {
    const program = new PublicKey(id);
    out.push(program);
    for (const seed of [config, "authority"]) out.push(PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0]);
  }
  return [...new Map(out.map((k) => [k.toBase58(), k])).values()];
}

const key = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const [mode, ...args] = process.argv.slice(2);
const conn = new Connection(RPC, "confirmed");

async function send(payer, ...ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

if (mode === "plan") {
  for (const a of addresses(args[0], args[1])) console.log(a.toBase58());
} else if (mode === "create") {
  const payer = key(args[0]);
  const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: (await conn.getSlot("finalized")) });
  console.log("create", table.toBase58(), await send(payer, ix));
  console.log("extend", await send(payer, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addresses(args[1], args[2]) })));
  console.log(`set TESORO_SPONSOR_LOOKUP_TABLES to include ${table.toBase58()}`);
} else if (mode === "extend") {
  const payer = key(args[0]);
  const table = new PublicKey(args[1]);
  const have = new Set((await conn.getAddressLookupTable(table)).value?.state.addresses.map((a) => a.toBase58()) ?? []);
  const missing = addresses(args[2], args[3]).filter((a) => !have.has(a.toBase58()));
  if (!missing.length) console.log("nothing to add");
  else console.log("extend", missing.map((a) => a.toBase58()).join(" "), await send(payer, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: missing })));
} else {
  console.error("usage: plan | create | extend (see the header)");
  process.exit(1);
}
