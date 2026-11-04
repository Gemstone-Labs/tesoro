// kd-02 shared helpers. Nothing here signs or sends: every transaction is compiled unsigned and simulated with sigVerify off.
import { writeFileSync } from "node:fs";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AccountMeta, type TransactionInstruction,
} from "@solana/web3.js";
import { Budget, type Ctx } from "../../src/act.ts";
import { settings } from "../../src/env.ts";
import { buildRuntime, newConnection } from "../../src/runtime.ts";

export const RPC = process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";
export const GPA = process.env.GPA_RPC ?? "https://api.devnet.solana.com";
/** Public addresses of the QA dev keys (derived from the keypair files' public halves; no secrets are used). */
export const QA = {
  qsA: new PublicKey("8nHkEzKuKbetyTkotFEmStsEP9Y1rXQEc8PrkZhwwKXA"),
  qsB: new PublicKey("4VMYBsm6bU4ZqFRGbn7epwEKfBBVuXvLU1vL2xa6DeVL"),
  qeF: new PublicKey("Ano1nkrsEzB3ubSeFNgnTc9MooCK37399Cmw2vQUtnRR"),
};
/** core's Sponsor account; its `relayer` field (offset 9) is the fee payer of sponsored transactions. Only the public address is read. */
export const SPONSOR = new PublicKey("4F8LcgHkFxPwShpfAckiwTBEBCfN43qFkmtyFdsw5oxT");
export async function relayerKey(): Promise<PublicKey> {
  const info = await retry(() => conn.getAccountInfo(SPONSOR));
  if (!info) throw new Error("no Sponsor account");
  return new PublicKey(info.data.subarray(9, 41));
}

export async function retry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

/** A keeper Ctx for building instructions. The payer is a public address with an empty secret: it can never sign. */
export function makeCtx(payerPub: PublicKey): Ctx {
  const s = settings(["--dry-run", "--rpc", RPC, "--gpa-rpc", GPA]);
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = { publicKey: payerPub, secretKey: new Uint8Array(64) } as unknown as Keypair;
  return { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
}

export const conn = new Connection(RPC, "confirmed");
export const gpaConn = new Connection(GPA, "confirmed");

export interface Sim {
  err: unknown;
  units: number | null;
  logs: string[];
  bytes: number;
  raw?: Buffer;
}

const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
export const withCu = (units: number, ...ixs: TransactionInstruction[]) => [cu(units), ...ixs];

/** Compiles `ixs` to an unsigned v0 message (optionally with lookup tables) and simulates it. */
const sv = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/** Wire size of a v0 transaction (signature placeholders included); web3.js cannot serialize one over 1,232 bytes. */
export function v0Size(msg: ReturnType<TransactionMessage["compileToV0Message"]>): number {
  const nSig = msg.header.numRequiredSignatures;
  let n = 1 + 3 + sv(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length + 32;
  n += sv(msg.compiledInstructions.length);
  for (const c of msg.compiledInstructions) n += 1 + sv(c.accountKeyIndexes.length) + c.accountKeyIndexes.length + sv(c.data.length) + c.data.length;
  n += sv(msg.addressTableLookups.length);
  for (const t of msg.addressTableLookups) n += 32 + sv(t.writableIndexes.length) + t.writableIndexes.length + sv(t.readonlyIndexes.length) + t.readonlyIndexes.length;
  return sv(nSig) + 64 * nSig + n;
}

export async function simV0(payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = [], run = true): Promise<Sim> {
  const { blockhash } = await retry(() => conn.getLatestBlockhash());
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const size = v0Size(msg);
  if (!run || size > 1232) return { err: size > 1232 ? `too large to send (${size} > 1232)` : null, units: null, logs: [], bytes: size };
  const tx = new VersionedTransaction(msg);
  const raw = Buffer.from(tx.serialize());
  if (raw.length !== size) throw new Error(`v0Size ${size} != serialized ${raw.length}`);
  const r = (await retry(() => conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }))).value;
  return { err: r.err, units: r.unitsConsumed ?? null, logs: r.logs ?? [], bytes: raw.length, raw };
}

export interface Shape {
  /** Unique accounts, programs counted once. */
  unique: number;
  signers: string[];
  programs: string[];
  /** Accounts a lookup table can hold: not a signer and not a program id. */
  lookupable: PublicKey[];
  writable: number;
}

export function shapeOf(payer: PublicKey, ixs: TransactionInstruction[]): Shape {
  const roles = new Map<string, { signer: boolean; writable: boolean; program: boolean }>();
  const touch = (k: PublicKey, o: { signer?: boolean; writable?: boolean; program?: boolean }) => {
    const r = roles.get(k.toBase58()) ?? { signer: false, writable: false, program: false };
    roles.set(k.toBase58(), { signer: r.signer || !!o.signer, writable: r.writable || !!o.writable, program: r.program || !!o.program });
  };
  touch(payer, { signer: true, writable: true });
  for (const ix of ixs) {
    touch(ix.programId, { program: true });
    for (const m of ix.keys) touch(m.pubkey, { signer: m.isSigner, writable: m.isWritable });
  }
  const all = [...roles.entries()];
  return {
    unique: all.length,
    signers: all.filter(([, r]) => r.signer).map(([k]) => k),
    programs: all.filter(([, r]) => r.program).map(([k]) => k),
    lookupable: all.filter(([, r]) => !r.signer && !r.program).map(([k]) => new PublicKey(k)),
    writable: all.filter(([, r]) => r.writable).length,
  };
}

/** A lookup table that exists only in memory, holding `addresses`: gives the exact v0 size with an ideal table. */
export const fakeAlt = (addresses: PublicKey[]) =>
  new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });

export interface BundleReport {
  name: string;
  feePayer: string;
  instructions: { program: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
}

export const toReport = (name: string, payer: PublicKey, ixs: TransactionInstruction[]): BundleReport => ({
  name,
  feePayer: payer.toBase58(),
  instructions: ixs.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((k: AccountMeta) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data).toString("base64"),
  })),
});

export const saveReports = (path: string, reports: BundleReport[]) => writeFileSync(path, JSON.stringify(reports, null, 1));

/** Prints size and account facts of a bundle for the note; returns the numbers for the table. */
export async function measureBundle(name: string, payer: PublicKey, ixs: TransactionInstruction[], opts: { stable?: PublicKey[] } = {}) {
  const shape = shapeOf(payer, ixs);
  const bare = await simV0(payer, ixs, [], false);
  const ideal = await simV0(payer, ixs, [fakeAlt(shape.lookupable)], false);
  const sigs = shape.signers.length;
  // A shared table can only hold accounts that do not depend on the Player or the Position: `stable` names them.
  const stableSet = new Set((opts.stable ?? []).map((k) => k.toBase58()));
  const stableUsed = shape.lookupable.filter((k) => stableSet.has(k.toBase58()));
  const shared = opts.stable ? await simV0(payer, ixs, [fakeAlt(stableUsed)], false) : null;
  const out = {
    name,
    uniqueAccounts: shape.unique,
    signers: sigs,
    programs: shape.programs.length,
    lookupable: shape.lookupable.length,
    writable: shape.writable,
    legacyBytes: legacyBytes(payer, ixs),
    v0NoAltBytes: bare.bytes,
    v0IdealAltBytes: ideal.bytes,
    ...(shared ? { stableAltAccounts: stableUsed.length, v0StableAltBytes: shared.bytes, perTxStatic: shape.unique - stableUsed.length } : {}),
  };
  console.log(JSON.stringify(out));
  return { out, shape };
}

// ---- real past transactions ------------------------------------------------------------------------------------------

export interface Parsed {
  sig: string;
  version: "legacy" | number;
  feePayer: PublicKey;
  /** Non-ComputeBudget top-level instructions with every account resolved (lookup-table accounts included). */
  ixs: TransactionInstruction[];
  names: string[];
  /** CU of each top-level instruction that is not ComputeBudget. */
  cu: number[];
  totalCu: number;
  staticKeys: number;
  loadedKeys: number;
  tables: PublicKey[];
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/** Reads one past transaction and rebuilds its instructions with the accounts it really used. */
export async function fetchParsed(sig: string): Promise<Parsed | null> {
  const { TransactionInstruction } = await import("@solana/web3.js");
  const tx = await retry(() => conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  if (!tx?.meta || tx.meta.err) return null;
  const msg: any = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const staticN = msg.staticAccountKeys.length;
  const nLoaded = keys.length - staticN;
  const loaded = (tx.meta.loadedAddresses?.writable.length ?? 0) + (tx.meta.loadedAddresses?.readonly.length ?? 0);
  const writableLoaded = tx.meta.loadedAddresses?.writable.length ?? 0;
  const isWritable = (i: number) => (i < staticN ? msg.isAccountWritable(i) : i - staticN < writableLoaded);
  const isSigner = (i: number) => i < staticN && msg.isAccountSigner(i);
  const ixs: TransactionInstruction[] = [];
  for (const c of msg.compiledInstructions) {
    const program = keys.get(c.programIdIndex)!;
    if (program.toBase58() === COMPUTE_BUDGET) continue;
    ixs.push(new TransactionInstruction({ programId: program, keys: c.accountKeyIndexes.map((i: number) => ({ pubkey: keys.get(i)!, isSigner: isSigner(i), isWritable: isWritable(i) })), data: Buffer.from(c.data) }));
  }
  // names and CU from the logs, top-level only
  const names: string[] = [];
  const cu: number[] = [];
  const stack: { name: string; program: string }[] = [];
  for (const l of tx.meta.logMessages ?? []) {
    let m = /^Program (\w+) invoke \[(\d+)\]/.exec(l);
    if (m) {
      stack.push({ name: "", program: m[1] });
      continue;
    }
    m = /^Program log: Instruction: (\w+)/.exec(l);
    if (m && stack.length && !stack[stack.length - 1].name) stack[stack.length - 1].name = m[1];
    m = /^Program (\w+) consumed (\d+) of/.exec(l);
    if (m && stack.length === 1 && stack[0].program !== COMPUTE_BUDGET) {
      names.push(stack[0].name || stack[0].program.slice(0, 4));
      cu.push(Number(m[2]));
    }
    if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
  }
  void nLoaded;
  return {
    sig,
    version: tx.version as "legacy" | number,
    feePayer: msg.staticAccountKeys[0],
    ixs,
    names,
    cu,
    totalCu: tx.meta.computeUnitsConsumed ?? 0,
    staticKeys: staticN,
    loadedKeys: loaded,
    tables: (msg.addressTableLookups ?? []).map((t: any) => t.accountKey),
  };
}

/** Legacy message size (with signature placeholders) of the instructions: null when it cannot be compiled. */
export function legacyBytes(payer: PublicKey, ixs: TransactionInstruction[]): number {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToLegacyMessage();
  const nSig = msg.header.numRequiredSignatures;
  let n = 3 + sv(msg.accountKeys.length) + 32 * msg.accountKeys.length + 32 + sv(msg.compiledInstructions.length);
  for (const c of msg.compiledInstructions) n += 1 + sv(c.accountKeyIndexes.length) + c.accountKeyIndexes.length + sv(c.data.length) + c.data.length;
  return sv(nSig) + 64 * nSig + n;
}

export async function loadAlt(key: PublicKey): Promise<AddressLookupTableAccount> {
  const r = await retry(() => conn.getAddressLookupTable(key));
  if (!r.value) throw new Error(`lookup table ${key.toBase58()} not found`);
  return r.value;
}
