/**
 * Moves Tesoro's authorities behind a Squads v4 multisig (ticket 36, docs/mainnet-keys.md). DRY RUN BY DEFAULT: prints the
 * exact instructions and commands and sends nothing. Only `--execute` sends, and only the Solana steps that the single
 * CURRENT key signs (steps for the vault go through Squads proposals; EVM steps are cast commands, never sent here).
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/mainnet-keys.ts \
 *     --vault <SQUADS_VAULT_PDA> --current <DEPLOYER_PUBKEY> --oracle <ORACLE_PUBKEY> --platform-bps 200 \
 *     [--invite <PUBKEY>] [--include-sim-lst] [--program tesoro_core=<ID> ...] \
 *     [--evm ethereum,<VAULT>,<RPC>,<SAFE> ...] \
 *     [--execute --rpc <URL> --keypair <CURRENT_KEYPAIR_FILE>]
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { buildPlan, describe, PROGRAMS, type PlanInput, type ProgramName } from "../src/mainnet-keys.ts";

const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const values = (n: string) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]] : []));
const one = (n: string) => values(n)[0];
const need = (n: string) => {
  const v = one(n);
  if (!v) throw new Error(`--${n} is required`);
  return v;
};
const key = (n: string) => {
  try {
    return new PublicKey(need(n));
  } catch {
    throw new Error(`--${n} is not a Solana address`);
  }
};

const programs: PlanInput["programs"] = {};
for (const kv of values("program")) {
  const [name, id] = kv.split("=");
  if (!(name in PROGRAMS) || !id) throw new Error(`--program ${kv}: expected <${Object.keys(PROGRAMS).join("|")}>=<ID>`);
  programs[name as ProgramName] = id;
}
const evm = values("evm").map((v) => {
  const [chain, vault, rpc, newOwner] = v.split(",");
  if ((chain !== "ethereum" && chain !== "hyperevm") || !/^0x[0-9a-fA-F]{40}$/.test(vault ?? "") || !rpc || !/^0x[0-9a-fA-F]{40}$/.test(newOwner ?? "")) {
    throw new Error(`--evm ${v}: expected <ethereum|hyperevm>,<vault 0x...>,<rpc url>,<new owner 0x...>`);
  }
  return { chain, vault, rpc, newOwner } as const;
});

const input: PlanInput = {
  vault: key("vault"),
  current: key("current"),
  oracle: key("oracle"),
  platformBps: Number(need("platform-bps")),
  invite: one("invite") ? key("invite") : undefined,
  programs,
  includeSimLst: flag("include-sim-lst"),
  evm,
};
if (input.current.toBase58() === COMPROMISED) throw new Error("--current is the compromised key; never use it");

const steps = buildPlan(input);
const execute = flag("execute");
console.log(execute ? "MODE: EXECUTE (sends the Solana steps signed by the current key)" : "MODE: DRY RUN (nothing is sent; add --execute to send)");
console.log(`vault ${input.vault.toBase58()}   current ${input.current.toBase58()}   oracle ${input.oracle.toBase58()}\n`);
for (const s of steps) console.log(describe(s) + "\n");

if (!execute) {
  console.log("Dry run only. Review every account above against docs/mainnet-keys.md, then see its 'Order of operations'.");
  process.exit(0);
}

const rpc = need("rpc");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("keypair"), "utf8"))));
if (signer.publicKey.toBase58() === COMPROMISED) throw new Error("--keypair is the compromised key");
if (!signer.publicKey.equals(input.current)) throw new Error(`--keypair is ${signer.publicKey.toBase58()}, not --current`);
const conn = new Connection(rpc, "confirmed");
console.log(`cluster genesis ${await conn.getGenesisHash()} (check it is the cluster you mean)`);
for (const s of steps) {
  if (s.kind !== "solana" || s.signer !== "current") continue;
  const tx = new Transaction().add(s.ix);
  tx.feePayer = signer.publicKey;
  console.log(`[${s.id}] sending ${s.title}`);
  console.log(`[${s.id}] ->`, await sendAndConfirmTransaction(conn, tx, [signer]));
}
