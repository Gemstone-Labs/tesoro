import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { HoldemChain, keypairSigner as holdemSigner } from "../../app/src/games/holdem/chain.ts";
import { SplitConnection, type GpaFn } from "../../app/src/lib/chain/split-connection.ts";
import type { Settings } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
/** The app's IDL copies are the shared source; a fresh `target/idl` (from `anchor build`) wins when present. */
const idlDirs = [process.env.TESORO_IDL_DIR, join(repo, "target/idl")].filter((d): d is string => !!d);
const appIdlDir = join(repo, "app/src/lib/chain/idl");

/** IDL of a program: `target/idl` when built here, else the app's copy. */
export function loadIdl(name: string): any {
  for (const d of [...idlDirs, appIdlDir]) {
    const p = join(d, `${name}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`IDL ${name} not found`);
}

/** Whether the IDL we can see knows an instruction (i.e. the program was built with it). */
export const hasInstruction = (idl: any, name: string) => idl.instructions.some((i: any) => i.name === name);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set when any RPC call saw a 429 since the last reset; the loop reads it to back off. */
export const rateLimit = { hits: 0 };

/** fetch that retries 429s with exponential backoff (web3.js only retries a few times, quickly). */
async function fetchWithBackoff(input: any, init?: any): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || i >= 5) return res;
    rateLimit.hits++;
    await sleep(1000 * 2 ** i);
  }
}

export interface Runtime {
  settings: Settings;
  conn: Connection;
  payer: Keypair;
  bp: BlockPuzzleChain;
  holdem: HoldemChain;
  signer: ReturnType<typeof keypairSigner>;
  hsigner: ReturnType<typeof holdemSigner>;
  core: BlockPuzzleChain["core"];
  coreIdl: any;
  /** Unix seconds of the cluster (the clock the programs use), not the local one. */
  now: number;
}

const connConfig = { commitment: "confirmed", fetch: fetchWithBackoff as typeof fetch, disableRetryOnRateLimit: true } as const;

/** Sends and single reads on `rpc`; getProgramAccounts on `gpaRpc`, shared for 5s (one loop asks for the same list many times). */
export function newConnection(rpc: string, gpaRpc: string = rpc): Connection {
  const gpaConn = new Connection(gpaRpc, connConfig);
  const seen = new Map<string, { at: number; p: Promise<any> }>();
  const gpa: GpaFn = (programId, config) => {
    const key = `${programId.toBase58()}:${JSON.stringify(config ?? {})}`;
    const hit = seen.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.p;
    const p = gpaConn.getProgramAccounts(programId, config as any) as Promise<any>;
    seen.set(key, { at: Date.now(), p });
    p.catch(() => seen.delete(key));
    return p;
  };
  return new SplitConnection(rpc, gpa, connConfig);
}

export function buildRuntime(settings: Settings, conn: Connection, payer: Keypair): Runtime {
  const coreIdl = loadIdl("tesoro_core");
  const bp = new BlockPuzzleChain({ base: conn, blockPuzzleIdl: loadIdl("block_puzzle"), coreIdl });
  const holdem = new HoldemChain(loadIdl("holdem"), coreIdl, { base: conn });
  return { settings, conn, payer, bp, holdem, signer: keypairSigner(payer), hsigner: holdemSigner(payer), core: bp.core, coreIdl, now: 0 };
}

/** Cluster time, so deadline checks agree with the on-chain Clock. */
export async function clusterNow(conn: Connection): Promise<number> {
  const slot = await conn.getSlot("confirmed");
  return (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

export const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
