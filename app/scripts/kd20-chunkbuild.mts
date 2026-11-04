/** Rebuilds a landed match_chunk with the relayer as caller and asks the sponsor to build it; prints the sponsor's answer. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3022";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;
const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { sponsorBuild, sponsorStatus } = await import("@/lib/chain/sponsor-client");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[0]));
const signer = Object.assign(keypairSigner(kp), { async signSerialized(b: Uint8Array) { const t = VersionedTransaction.deserialize(b); t.sign([kp]); return t.serialize(); } });
const conn = new Connection("https://rpc.magicblock.app/devnet");
const tx = await conn.getTransaction(process.argv[2], { maxSupportedTransactionVersion: 0 });
const m = tx!.transaction.message;
const keys = m.getAccountKeys({ accountKeysFromLookups: tx!.meta?.loadedAddresses });
const keeper = keys.get(0)!;
const relayer = new PublicKey((await sponsorStatus()).relayer);
const ci = m.compiledInstructions.find((i) => i.data.length > 8 && keys.get(i.programIdIndex)!.toBase58().startsWith("AR9c"))!;
const ix = new TransactionInstruction({ programId: keys.get(ci.programIdIndex)!, data: Buffer.from(ci.data), keys: ci.accountKeyIndexes.map((k) => { const pk = keys.get(k)!; return { pubkey: pk.equals(keeper) ? relayer : pk, isSigner: m.isAccountSigner(k), isWritable: pk.equals(keeper) ? false : m.isAccountWritable(k) }; }) });
try { console.log("built", Object.keys(await sponsorBuild(signer as never, async () => null, [ix]))); } catch (e) { console.log("REFUSED", (e as Error).message, (e as { code?: string }).code); }
process.exit(0);
