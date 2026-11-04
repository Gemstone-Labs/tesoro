/**
 * Devnet check for the keeper-diet switch-over: fresh wallets with zero SOL get an Account, simSOL and an Advance through the
 * app server (SPONSOR_ORIGIN), then open and join Matches sponsored. Keys are written to KD20_KEYS (default scratch) and never printed.
 *   cd app && SPONSOR_ORIGIN=http://localhost:3021 ../keeper/node_modules/.bin/tsx scripts/kd20-fresh.mts fund
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3021";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;

const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const KEYS = process.env.KD20_KEYS ?? join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json");
const kps = (): Keypair[] => {
  if (!existsSync(KEYS)) writeFileSync(KEYS, JSON.stringify([Keypair.generate(), Keypair.generate()].map((k) => Array.from(k.secretKey))), { mode: 0o600 });
  return (JSON.parse(readFileSync(KEYS, "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
};
const noToken = async () => null;
const [cmd] = process.argv.slice(2);
if (cmd === "fund") {
  const { getTestSimSol, openPositionWithAdvance } = await import("@/lib/chain/native-flow");
  for (const kp of kps()) {
    const s = keypairSigner(kp);
    console.log("wallet", kp.publicKey.toBase58().slice(0, 6));
    try {
      console.log("faucet", await getTestSimSol(s as never, noToken));
    } catch (e) {
      console.log("faucet FAILED:", String((e as Error).message ?? e).slice(0, 200));
    }
    try {
      console.log("advance", (await openPositionWithAdvance(s as never, noToken, 10_000_000_000n, 3, 1n, (m) => console.log("  ", m))).signature);
    } catch (e) {
      console.log("advance FAILED:", String((e as Error).message ?? e).slice(0, 300));
    }
  }
  process.exit(0);
}
