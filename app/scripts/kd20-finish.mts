/** Runs the page's finish (chunks + close, sponsored) for a Match as fresh wallet 0 and prints the result. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3021";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;
const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { finishMatchFree } = await import("@/lib/chain/finish-match-client");
const { matchAddressOf } = await import("@/lib/chain/match-id");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[0]));
const s = Object.assign(keypairSigner(kp), { async signSerialized(b: Uint8Array) { const t = VersionedTransaction.deserialize(b); t.sign([kp]); return t.serialize(); } });
console.log(JSON.stringify(await finishMatchFree(s as never, async () => null, matchAddressOf(process.argv[2])!)));
process.exit(0);
