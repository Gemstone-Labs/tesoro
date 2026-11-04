/** Runs one Block Burst page driver on an existing Match for N seconds and prints its stage, errors and sent signatures. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3021";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;
const { getChain } = await import("@/lib/chain/client");
const { BlockBurstChain, keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { BlockPuzzleChain } = await import("@/games/block-puzzle/chain");
const { BurstDriver } = await import("@/games/block-puzzle/burst-driver");
const { fetchMatch } = await import("@/lib/chain/read");
const bp = (await import("@/lib/chain/idl/block_puzzle.json", { with: { type: "json" } })).default;
const core = (await import("@/lib/chain/idl/tesoro_core.json", { with: { type: "json" } })).default;
const [key, who, secs] = process.argv.slice(2);
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[Number(who ?? 0)]));
const signer = Object.assign(keypairSigner(kp), { async signSerialized(b: Uint8Array) { const t = VersionedTransaction.deserialize(b); t.sign([kp]); return t.serialize(); } });
const chain = new BlockBurstChain(bp as never, core, { base: getChain().base });
for (const m of ["beginMatch", "seatPlayers", "requestSeed", "start", "checkIn", "begin", "close", "commitTable"] as const) {
  const orig = (chain as never as Record<string, (...a: unknown[]) => Promise<unknown>>)[m].bind(chain);
  (chain as never as Record<string, unknown>)[m] = async (...a: unknown[]) => { try { const r = await orig(...a); console.log(m, "ok", String(r).slice(0, 20)); return r; } catch (e) { console.log(m, "ERR", String((e as Error).message ?? e).slice(0, 400)); throw e; } };
}
const d = new BurstDriver({ onTx: (l: string, layer: string, sig: string) => console.log("tx", l, layer, sig.slice(0, 12)), id: key, signer: signer as never, accountKey: BlockPuzzleChain.coreAccount(signer.publicKey).toBase58(), getToken: async () => null, chain, fetchMatch } as never);
d.subscribe((v: { stage: string; error?: string | null }) => console.log("view", v.stage, v.error ?? ""));
d.start();
await new Promise((r) => setTimeout(r, Number(secs ?? 30) * 1000));
const v = (d as unknown as { view: Record<string, unknown> }).view;
console.log("final view", JSON.stringify({ stage: v.stage, error: v.error, reconnecting: v.reconnecting, hasAssignment: !!v.assignment, hasTable: !!v.table, seat: v.seat }));
process.exit(0);
