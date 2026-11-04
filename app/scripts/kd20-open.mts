/** Opens a Block Burst Match as fresh wallet 0 and joins it as fresh wallet 1, both sponsored, then prints the key. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3021";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;
const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { openEntry, joinEntry } = await import("@/lib/chain/entry-flow");
const kps = (JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const sg = (kp: Keypair) => Object.assign(keypairSigner(kp), { async signSerialized(b: Uint8Array) { const t = VersionedTransaction.deserialize(b); t.sign([kp]); return t.serialize(); } });
const { key } = await openEntry({ signer: sg(kps[0]) as never, getToken: async () => null, game: "block-puzzle", entry: 100, challenge: false });
console.log("KEY", key);
await joinEntry({ signer: sg(kps[1]) as never, getToken: async () => null, game: "block-puzzle", entry: 100, key });
console.log("joined", new Date().toISOString());
process.exit(0);
