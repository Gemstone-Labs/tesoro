/** Shared command-line handling for the admin scripts: flags, keypair files, cluster and program overrides. */
import { existsSync, readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CLUSTERS, type ClusterSettings } from "../../app/src/lib/cluster-settings.ts";
import { PROGRAMS, type ProgramName } from "./mainnet-keys.ts";

/** The key that leaked on 2026-10-01; no script may sign with it. */
export const COMPROMISED_KEY = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";
/** Test mode defaults; mainnet runs always pass --rpc. */

export interface Args {
  flag(name: string): boolean;
  value(name: string): string | undefined;
  values(name: string): string[];
  need(name: string): string;
  /** Arguments that are not flags or flag values, in order. */
  positional: string[];
}

/** `--name value` pairs and bare `--name` flags (those named in `bare`). */
export function parseArgs(argv: string[], bare: string[] = []): Args {
  const isBare = (a: string) => bare.includes(a.slice(2));
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (!isBare(argv[i])) i++;
    } else positional.push(argv[i]);
  }
  const values = (n: string) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  return {
    flag: (n) => argv.includes(`--${n}`),
    value: (n) => values(n)[0],
    values,
    need: (n) => {
      const v = values(n)[0];
      if (!v) throw new Error(`--${n} is required`);
      return v;
    },
    positional,
  };
}

/** `--program name=ID` overrides on top of the repo's (devnet) ids. */
export function programOverrides(values: string[]): Partial<Record<ProgramName, string>> {
  const out: Partial<Record<ProgramName, string>> = {};
  for (const kv of values) {
    const [name, id] = kv.split("=");
    if (!(name in PROGRAMS) || !id) throw new Error(`--program ${kv}: expected <${Object.keys(PROGRAMS).join("|")}>=<ID>`);
    new PublicKey(id);
    out[name as ProgramName] = id;
  }
  return out;
}

export const programId = (name: ProgramName, over: Partial<Record<ProgramName, string>>) => new PublicKey(over[name] ?? PROGRAMS[name]);

export function loadKeypair(path: string): Keypair {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  if (kp.publicKey.toBase58() === COMPROMISED_KEY) throw new Error(`${path} is the compromised key; never use it`);
  return kp;
}

/** A base58 address as is, or the public key of a keypair file. */
export function resolveKey(v: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    if (!existsSync(v)) throw new Error(`${v} is neither a Solana address nor a keypair file`);
    return loadKeypair(v).publicKey;
  }
}

export function clusterOf(name: string | undefined): ClusterSettings {
  const id = name ?? "mainnet";
  if (id !== "test" && id !== "mainnet") throw new Error(`--cluster must be test or mainnet, not ${id}`);
  return CLUSTERS[id];
}

/** Throws unless the RPC serves the cluster's Solana network (genesis hash). */
export async function assertCluster(conn: Connection, cluster: ClusterSettings): Promise<void> {
  const hash = await conn.getGenesisHash();
  if (hash !== cluster.solana.genesisHash) throw new Error(`the RPC is not ${cluster.solana.label} (genesis ${hash}); refusing`);
}

/** What an admin script signs and sends with. */
export interface Signing {
  cluster: ClusterSettings;
  rpc: string;
  keypair: Keypair;
  conn: Connection;
  program: PublicKey;
}

/**
 * --cluster (default test for the older scripts), --rpc (devnet default only in test mode; mainnet needs one), --keypair
 * (or TESORO_ADMIN_KEYPAIR; there is no default file) and --program tesoro_core=ID. The RPC must serve the cluster.
 */
export async function adminSigning(a: Args, over: Partial<Record<ProgramName, string>> = {}): Promise<Signing> {
  const cluster = clusterOf(a.value("cluster") ?? "test");
  const rpc = a.value("rpc") ?? process.env.RPC_URL ?? cluster.solana.defaultRpc;
  if (!rpc) throw new Error("--rpc is required on mainnet");
  const keypair = loadKeypair(a.value("keypair") ?? process.env.TESORO_ADMIN_KEYPAIR ?? (() => { throw new Error("--keypair <file> is required"); })());
  const conn = new Connection(rpc, "confirmed");
  await assertCluster(conn, cluster);
  return { cluster, rpc, keypair, conn, program: programId("tesoro_core", over) };
}

/** The common flags every admin script shares, for usage text. */
export const COMMON_FLAGS = "--keypair <file> [--rpc <url>] [--cluster test|mainnet] [--program tesoro_core=<ID>]";
