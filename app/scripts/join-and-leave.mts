/**
 * Joins an open Block Burst Match as the second tester wallet and is never seen again: no page, no check-in. For checking what
 * a real browser page does when its opponent is absent.
 *
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/join-and-leave.mts <match key> [testers file]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => {
  if (typeof u === "string" && u.startsWith("/api/sponsor")) return Promise.resolve(new Response(JSON.stringify({ error: "off", code: "sponsor-paused" }), { status: 503 }));
  return realFetch(typeof u === "string" && u.startsWith("/") ? "https://www.playtesoro.com" + u : u, i);
}) as typeof fetch;

const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { joinEntry } = await import("@/lib/chain/entry-flow");
const [key, file] = process.argv.slice(2);
if (!key) throw new Error("usage: join-and-leave.mts <match key> [testers file]");
const testers = (JSON.parse(readFileSync(join(homedir(), ".config/tesoro", file ?? "block-puzzle-fragment-testers.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const t0 = Date.now();
await joinEntry({ signer: keypairSigner(testers[1]) as never, getToken: async () => null, game: "block-puzzle", entry: Number(process.env.ENTRY ?? 100), key });
console.log(`joined ${key} at ${new Date().toISOString()} (${Date.now() - t0} ms)`);
process.exit(0);
