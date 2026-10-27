import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assertSolana, keeperCluster } from "./cluster.ts";
import { keypairFromEnv } from "./keys.ts";

/** Fill unset env vars from app/.env.local so RPC keys live in one place (never overrides the real env). */
export function loadAppEnv(env: NodeJS.ProcessEnv = process.env, file = fileURLToPath(new URL("../../app/.env.local", import.meta.url))) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#") || env[m[1]]) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export interface Settings {
  /** Sends and single-account reads. */
  rpc: string;
  /** List queries (getProgramAccounts): the public devnet RPC allows them, most free tiers do not. */
  gpaRpc: string;
  keypairPath: string;
  intervalMs: number;
  /** Between full passes, how often the Block Burst fast lane runs (0 turns it off). */
  fastMs: number;
  once: boolean;
  /** Max lamports the keeper payer may spend (fees + rent) in any rolling hour. */
  hourlyCapLamports: number;
  /** Max LayerZero fee of one Solana-side send, and the max the keeper pays for them in any rolling hour. */
  maxLzFeeLamports: number;
  lzHourlyCapLamports: number;
  hoodiRpc: string;
  hyperEvmRpc: string;
  /** Simulated: report what would be done, send nothing. */
  dryRun: boolean;
}

export function settings(argv = process.argv.slice(2), env = process.env): Settings {
  if (env === process.env) loadAppEnv(env);
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cluster = keeperCluster(env);
  /** The public test-mode RPC when unset; mainnet has no default, so an unset RPC is an error. */
  const rpcOr = (v: string | undefined, name: string, testDefault: string | undefined) => {
    if (v) return v;
    if (cluster.id === "test" && testDefault) return testDefault;
    throw new Error(`${name} is not set; mainnet has no default RPC`);
  };
  const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    rpc: rpcOr(value("rpc") || env.KEEPER_RPC || env.TESORO_BASE_RPC, "KEEPER_RPC", cluster.solana.defaultRpc),
    gpaRpc: rpcOr(value("gpa-rpc") || env.KEEPER_GPA_RPC, "KEEPER_GPA_RPC", cluster.solana.defaultGpaRpc),
    keypairPath: env.KEEPER_KEYPAIR ?? join(homedir(), ".config/tesoro/keeper.json"),
    intervalMs: num(value("interval") ?? env.KEEPER_INTERVAL_SECS, 20) * 1000,
    fastMs: num(value("fast") ?? env.KEEPER_FAST_SECS, 4) * 1000,
    once: flag("once"),
    hourlyCapLamports: Math.round(num(value("max-sol-per-hour") ?? env.KEEPER_MAX_SOL_PER_HOUR, 0.5) * LAMPORTS_PER_SOL),
    maxLzFeeLamports: Math.round(num(value("max-lz-fee-sol") ?? env.KEEPER_MAX_LZ_FEE_SOL, 0.005) * LAMPORTS_PER_SOL),
    lzHourlyCapLamports: Math.round(num(value("max-lz-sol-per-hour") ?? env.KEEPER_MAX_LZ_SOL_PER_HOUR, 0.05) * LAMPORTS_PER_SOL),
    hoodiRpc: rpcOr(value("hoodi-rpc") ?? env.KEEPER_HOODI_RPC, "KEEPER_HOODI_RPC", "https://ethereum-hoodi-rpc.publicnode.com"),
    hyperEvmRpc: rpcOr(value("hyperevm-rpc") ?? env.KEEPER_HYPEREVM_RPC, "KEEPER_HYPEREVM_RPC", "https://rpc.hyperliquid-testnet.xyz/evm"),
    dryRun: flag("dry-run"),
  };
}

/** Swept on 2026-10-01 (`~/.config/solana/id.json`): never sign with it. */
const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";

export function readKeypair(path: string): Keypair {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  if (kp.publicKey.toBase58() === COMPROMISED) throw new Error(`${path} is the compromised key ${COMPROMISED}; refusing to sign with it`);
  return kp;
}

/**
 * Refuses to start unless both RPCs serve the cluster's Solana network, then loads the keeper's payer: `KEEPER_SECRET_KEY` when set,
 * else the key file (created on first run). With `KEEPER_KEYS_FROM_ENV=1` (hosted) a missing secret is fatal instead.
 * The keeper never funds itself: an empty payer is reported and topped up by hand.
 */
export async function loadPayer(conn: Connection, s: Settings, log: (m: string) => void, gpa: Connection = conn): Promise<Keypair> {
  await assertSolana(conn, "KEEPER_RPC");
  if (s.gpaRpc !== s.rpc) await assertSolana(gpa, "KEEPER_GPA_RPC");
  let payer: Keypair;
  const secret = keypairFromEnv("KEEPER_SECRET_KEY");
  if (secret) {
    payer = secret;
  } else if (process.env.KEEPER_KEYS_FROM_ENV === "1") {
    throw new Error("KEEPER_SECRET_KEY is not set (KEEPER_KEYS_FROM_ENV=1: no key files on this host)");
  } else if (existsSync(s.keypairPath)) {
    payer = readKeypair(s.keypairPath);
  } else {
    mkdirSync(dirname(s.keypairPath), { recursive: true });
    payer = Keypair.generate();
    writeFileSync(s.keypairPath, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 });
    log(`wallet created ${payer.publicKey.toBase58()} at ${s.keypairPath}`);
  }
  const balance = await conn.getBalance(payer.publicKey);
  if (balance < 0.1 * LAMPORTS_PER_SOL) log(`WARN payer ${payer.publicKey.toBase58()} holds ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL; fund it by hand`);
  return payer;
}

export const shortKey = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}..${s.slice(-4)}`;
};
