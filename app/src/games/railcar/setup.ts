/**
 * Railcar's one-time chain setup as a plan: what to send, in order, who signs each step, and whether the chain already
 * holds it. Pure apart from the reads in `readSetupFacts`. Used by `keeper/scripts/railcar-setup.ts` (devnet) and by the
 * LiteSVM ride test, which sets Railcar up from scratch with these builders and then rides a car on it.
 *
 * Order: core Game (register, list, TEE-only delegation), Railcar config, Sponsor and Fuel, Tables, each Table's Vault
 * on the rollup. Each step lists the steps it needs (`after`), so a dry run can simulate a step with the ones not on
 * chain yet in front of it.
 */
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { TESORO_CORE } from "../../lib/chain/basket";
import { coreIx, coreIxName, idlIxBuilder } from "../../lib/chain/core-ix";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { rdU64, u64 } from "../../lib/chain/native";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { RAILCAR_PROGRAM_ID, authorityPda, configPda, decodeConfig, railcarIx, sponsorPda, tablePda, vaultPda } from "./chain";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// ---- Program constants (programs/railcar/src/state.rs) -----------------------------------------------------------------

export const MIN_TABLES = 2;
export const MAX_TABLES = 16;
/** Lamports `create_table` moves into a Table for its Vault's rent on the rollup. */
export const TABLE_BUFFER_LAMPORTS = 10_000_000n;
/** `Table::SPACE`: header, then 100 seats of 88 bytes. */
export const TABLE_SPACE = 8 + 308 + 100 * 88;
const CONFIG_SPACE = 8 + 1 + 32 + 2 + 8 + 32;
const SPONSOR_SPACE = 8 + 1;
const FUEL_SPACE = 8 + 2;
/** tesoro_core `GameRecord::SPACE`. */
const GAME_RECORD_SPACE = 265;
/** The delegation program's `p-conf` account with one approved validator. */
const PROGRAM_CONFIG_SPACE = 8 + 4 + 32;
/** What the delegation program keeps per delegated account: its record (96 B) and metadata (53 B + the seeds). */
const DELEGATION_RECORD_SPACE = 96;
const delegationMetadataSpace = (seeds: Uint8Array[]) => 53 + seeds.reduce((n, s) => n + 4 + s.length, 0);
const FEE_LAMPORTS = 5_000n;

/** Rent-exempt minimum for `bytes` of data at today's rate (3,480 lamports per byte-year, two years). */
export const rentOf = (bytes: number): bigint => BigInt(bytes + 128) * 6_960n;

// ---- Addresses --------------------------------------------------------------------------------------------------------

const le = (n: number, len: number) => {
  const b = Buffer.alloc(len);
  b.writeUIntLE(n, 0, len);
  return b;
};
const corePda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE)[0];
export const gameRecordPda = () => corePda(Buffer.from("game"), RAILCAR_PROGRAM_ID.toBuffer());
export const coreConfigPda = () => corePda(Buffer.from("config"));
export const economyPda = () => corePda(Buffer.from("economy"));
export const programDataPda = (program = RAILCAR_PROGRAM_ID) => PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER)[0];
export const fuelPda = (n: number) => PublicKey.findProgramAddressSync([Buffer.from("fuel"), Uint8Array.of(n)], RAILCAR_PROGRAM_ID)[0];
/** The delegation program's per-program config (`approved_validators`). */
export const programConfigPda = (program = RAILCAR_PROGRAM_ID) => PublicKey.findProgramAddressSync([Buffer.from("p-conf"), program.toBuffer()], DELEGATION_PROGRAM_ID)[0];

const delegationAccounts = (account: PublicKey, name: string) => ({
  [`buffer_${name}`]: PublicKey.findProgramAddressSync([Buffer.from("buffer"), account.toBuffer()], RAILCAR_PROGRAM_ID)[0],
  [`delegation_record_${name}`]: PublicKey.findProgramAddressSync([Buffer.from("delegation"), account.toBuffer()], DELEGATION_PROGRAM_ID)[0],
  [`delegation_metadata_${name}`]: PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), account.toBuffer()], DELEGATION_PROGRAM_ID)[0],
});

// ---- Instructions -----------------------------------------------------------------------------------------------------

/**
 * The delegation program's `whitelist_validator_for_program` (discriminator 8), signed by the program's upgrade authority:
 * once a program has a `p-conf`, its accounts can be delegated only to the validators it approves. Every live Game has
 * one naming only the TEE validator.
 */
export function whitelistValidatorIx(authority: PublicKey, validator: PublicKey, program = RAILCAR_PROGRAM_ID, insert = true): TransactionInstruction {
  return new TransactionInstruction({
    programId: DELEGATION_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: validator, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
      { pubkey: programDataPda(program), isSigner: false, isWritable: false },
      { pubkey: programDataPda(DELEGATION_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: programConfigPda(program), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([u64(8n), Buffer.from([insert ? 1 : 0])]),
  });
}

/** The validators a `p-conf` approves: 8-byte discriminator, then a Borsh set of keys. */
export function approvedValidators(data: Uint8Array): PublicKey[] {
  const b = Buffer.from(data);
  if (b.length < 12) return [];
  return Array.from({ length: b.readUInt32LE(8) }, (_, i) => new PublicKey(b.subarray(12 + 32 * i, 44 + 32 * i)));
}

/** tesoro_core's hash of a deployed build, as `list_game` checks it: the ELF after the 45-byte ProgramData header, trailing zeros cut. */
export function codeHash(programData: Uint8Array): Buffer {
  const code = Buffer.from(programData).subarray(45);
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) end--;
  return createHash("sha256").update(code.subarray(0, end)).digest();
}

/** The upgrade authority and deploy slot in a ProgramData account. */
export function programDataView(data: Uint8Array): { slot: bigint; authority: PublicKey | null } {
  const b = Buffer.from(data);
  return { slot: rdU64(b, 4), authority: b[12] === 1 ? new PublicKey(b.subarray(13, 45)) : null };
}

export const registerGameIx = (payer: PublicKey, control: PublicKey, studioAccount: PublicKey, studioBps: number) =>
  coreIx(
    "register_game",
    { payer, control, config: coreConfigPda(), game_program: RAILCAR_PROGRAM_ID, program_data: programDataPda(), studio_recipient: studioAccount, game_record: gameRecordPda() },
    { settle_authority: authorityPda(), studio_bps: studioBps },
  );

export const listGameIx = (admin: PublicKey, listedUntil: number, hash: Uint8Array) =>
  coreIx("list_game", { admin, config: coreConfigPda(), game_record: gameRecordPda(), game_program: RAILCAR_PROGRAM_ID, program_data: programDataPda() }, { listed_until: BigInt(listedUntil), approved_hash: Array.from(hash) });

export const setConfigIx = (authority: PublicKey, operator: PublicKey, tables: number) =>
  railcarIx("set_config", { authority, config: configPda(), program_data: programDataPda() }, { operator, tables });

export const createSponsorIx = (operator: PublicKey, lamports: bigint) => railcarIx("create_sponsor", { operator, config: configPda(), sponsor: sponsorPda() }, { lamports });

export const createFuelIx = (operator: PublicKey, n: number, lamports: bigint) => railcarIx("create_fuel", { operator, config: configPda(), fuel: fuelPda(n) }, { n, lamports });

export const createTableIx = (operator: PublicKey, index: number) => railcarIx("create_table", { operator, config: configPda(), table: tablePda(index) }, { index });

export const delegateSponsorIx = (operator: PublicKey, validator: PublicKey) =>
  railcarIx("delegate_sponsor", { operator, config: configPda(), sponsor: sponsorPda(), validator, ...delegationAccounts(sponsorPda(), "sponsor") });

export const delegateFuelIx = (operator: PublicKey, n: number, validator: PublicKey) =>
  railcarIx("delegate_fuel", { operator, config: configPda(), fuel: fuelPda(n), validator, ...delegationAccounts(fuelPda(n), "fuel") }, { n });

export const delegateTableIx = (operator: PublicKey, index: number, validator: PublicKey) =>
  railcarIx("delegate_table", { operator, config: configPda(), table: tablePda(index), validator, ...delegationAccounts(tablePda(index), "table") }, { index });

/** Rollup, anyone: the Table's private Vault (the Table pays its rent from the buffer `create_table` gave it). */
export function initVaultIx(caller: PublicKey, index: number): TransactionInstruction {
  const table = tablePda(index);
  const vault = vaultPda(table);
  return railcarIx("init_vault", { caller, table, vault, vault_permission: permissionPdaFromAccount(vault), permission_program: PERMISSION_PROGRAM_ID, ephemeral_vault: EPHEMERAL_VAULT_ID });
}

// ---- What the chain holds ---------------------------------------------------------------------------------------------

export type Held = "missing" | "program" | "delegated";

export interface SetupFacts {
  coreConfig: { admin: PublicKey; entries: bigint[] } | null;
  /** tesoro_core's `EconomyConfig.tesoro_studio`: the Account that takes the Studio Fee of Tesoro's own Games. */
  tesoroStudio: PublicKey | null;
  studioAccountExists: boolean;
  program: { slot: bigint; authority: PublicKey | null; hash: Buffer } | null;
  game: { settleAuthority: PublicKey; studioBps: number; studioRecipient: PublicKey; listedUntil: number; approvedSlot: bigint; approvedHash: Buffer } | null;
  approvedValidators: PublicKey[] | null;
  config: { operator: PublicKey; tables: number; nextCar: bigint } | null;
  sponsor: Held;
  fuel: Held;
  tables: { index: number; base: Held; vaultReady: boolean | null }[];
}

export interface AccountReader {
  getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
}

export interface SetupInput {
  /** Railcar's upgrade authority: registers the Game, approves the TEE validator, sets the config. On devnet the deployer. */
  upgradeAuthority: PublicKey;
  /** tesoro_core's admin: lists the Game. On devnet the deployer. */
  admin: PublicKey;
  /** Railcar's operator: creates and delegates the Sponsor, Fuel and Tables, refills the Sponsor. */
  operator: PublicKey;
  validator: PublicKey;
  /** The Studio's core Account (not its wallet). */
  studioAccount: PublicKey;
  studioBps: number;
  tables: number;
  sponsorLamports: bigint;
  fuelLamports: bigint;
  /** The Fuel reserve's number. */
  fuel: number;
  listedDays: number;
  /** Unix time of the run. */
  now: number;
}

const coreCoder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const num = (v: { toString(): string }) => BigInt(v.toString());

/** Reads everything the plan decides on: base in one call, the Tables' Vault flag from the rollup when `rollup` is given. */
export async function readSetupFacts(base: AccountReader, rollup: AccountReader | null, input: Pick<SetupInput, "tables" | "fuel" | "studioAccount">): Promise<SetupFacts> {
  const tables = Array.from({ length: input.tables }, (_, i) => tablePda(i));
  const keys = [coreConfigPda(), economyPda(), input.studioAccount, programDataPda(), gameRecordPda(), programConfigPda(), configPda(), sponsorPda(), fuelPda(input.fuel), ...tables];
  const [coreConfig, economy, studio, programData, game, pconf, config, sponsor, fuel, ...tableInfos] = await base.getMultipleAccountsInfo(keys);
  const held = (i: AccountInfo<Buffer> | null): Held => (!i ? "missing" : i.owner.equals(DELEGATION_PROGRAM_ID) ? "delegated" : "program");
  const onRollup = rollup ? await rollup.getMultipleAccountsInfo(tables) : null;
  const cc = coreConfig ? (coreCoder.decode("Config", coreConfig.data) as { admin: PublicKey; entry_sizes: { toString(): string }[] }) : null;
  const eco = economy ? (coreCoder.decode("EconomyConfig", economy.data) as { tesoro_studio: PublicKey }) : null;
  const rec = game
    ? (coreCoder.decode("GameRecord", game.data) as { settle_authority: PublicKey; studio_bps: number; studio_recipient: PublicKey; listed_until: { toString(): string }; approved_slot: { toString(): string }; approved_hash: number[] })
    : null;
  const pd = programData ? programDataView(programData.data) : null;
  const rc = config ? decodeConfig(config.data) : null;
  const entries = cc ? cc.entry_sizes.map(num).filter((e) => e !== 0n) : [];
  return {
    coreConfig: cc ? { admin: cc.admin, entries: entries.length ? entries : [100n, 500n, 1_000n] } : null,
    tesoroStudio: eco && !eco.tesoro_studio.equals(PublicKey.default) ? eco.tesoro_studio : null,
    studioAccountExists: !!studio && studio.owner.equals(TESORO_CORE),
    program: pd && programData ? { ...pd, hash: codeHash(programData.data) } : null,
    game: rec
      ? { settleAuthority: rec.settle_authority, studioBps: rec.studio_bps, studioRecipient: rec.studio_recipient, listedUntil: Number(num(rec.listed_until)), approvedSlot: num(rec.approved_slot), approvedHash: Buffer.from(rec.approved_hash) }
      : null,
    approvedValidators: pconf ? approvedValidators(pconf.data) : null,
    config: rc ? { operator: rc.operator, tables: rc.tables, nextCar: rc.nextCar } : null,
    sponsor: held(sponsor),
    fuel: held(fuel),
    tables: tableInfos.map((info, index) => {
      const live = onRollup?.[index];
      return { index, base: held(info), vaultReady: live && live.owner.equals(RAILCAR_PROGRAM_ID) ? live.data[8 + 15] === 1 : null };
    }),
  };
}

// ---- The plan ---------------------------------------------------------------------------------------------------------

export type Signer = "upgrade authority" | "admin" | "operator";

export interface SetupStep {
  id: string;
  title: string;
  why: string;
  signer: Signer;
  layer: "base" | "rollup";
  ixs: TransactionInstruction[];
  /** Compute unit limit for its transaction. */
  cu: number;
  /** done: the chain holds it; to do: send it; blocked: it cannot be sent (see `note`). */
  status: "done" | "to do" | "blocked";
  /** What the chain holds now, or why the step is blocked. */
  note: string;
  /** Steps this one needs on chain first. */
  after: string[];
  /** Estimated lamports the signer spends: rent of what it creates, lamports it funds, and the fee. Rollup steps cost 0. */
  lamports: bigint;
}

/** Problems that stop the whole plan before any step (wrong cluster state, a choice the chain refuses). */
export function setupProblems(input: SetupInput, facts: SetupFacts): string[] {
  const out: string[] = [];
  if (!facts.coreConfig) out.push("tesoro_core has no Config on this cluster");
  else {
    if (!facts.coreConfig.admin.equals(input.admin)) out.push(`tesoro_core's admin is ${facts.coreConfig.admin.toBase58()}, not ${input.admin.toBase58()}`);
    if (!facts.coreConfig.entries.includes(500n)) out.push(`tesoro_core's entry sizes (${facts.coreConfig.entries.join(", ")}) leave out Railcar's 500`);
  }
  if (!facts.program) out.push(`Railcar ${RAILCAR_PROGRAM_ID.toBase58()} is not deployed here`);
  else if (!facts.program.authority?.equals(input.upgradeAuthority)) out.push(`Railcar's upgrade authority is ${facts.program.authority?.toBase58() ?? "none"}, not ${input.upgradeAuthority.toBase58()}`);
  if (!facts.studioAccountExists) out.push(`the Studio Account ${input.studioAccount.toBase58()} does not exist`);
  if (!Number.isInteger(input.tables) || input.tables < MIN_TABLES || input.tables > MAX_TABLES) out.push(`--tables must be ${MIN_TABLES} to ${MAX_TABLES}`);
  if (input.operator.equals(PublicKey.default)) out.push("the operator may not be the default key");
  return out;
}

export function railcarSetupPlan(input: SetupInput, facts: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  const add = (s: Omit<SetupStep, "lamports" | "cu"> & { cu?: number; creates?: number[]; funds?: bigint }) =>
    steps.push({ ...s, cu: s.cu ?? 200_000, lamports: s.layer === "rollup" ? 0n : (s.creates ?? []).reduce((n, b) => n + rentOf(b), 0n) + (s.funds ?? 0n) + FEE_LAMPORTS });
  const delegation = (...seeds: Uint8Array[]) => [DELEGATION_RECORD_SPACE, delegationMetadataSpace(seeds)];
  const { operator, validator } = input;
  const short = (k: PublicKey) => k.toBase58().slice(0, 8);

  // 1. The Game in tesoro_core.
  const g = facts.game;
  add({
    id: "register-game",
    title: `tesoro_core register_game: Railcar, settle authority ${short(authorityPda())}, Studio Fee ${input.studioBps} bps to ${short(input.studioAccount)}`,
    why: "core settles a Railcar car only for the Game it knows, signed by Railcar's authority PDA; the Studio Fee goes to Tesoro's Studio Account like the other four Games",
    signer: "upgrade authority",
    layer: "base",
    ixs: [registerGameIx(input.upgradeAuthority, input.upgradeAuthority, input.studioAccount, input.studioBps)],
    status: g ? "done" : "to do",
    note: g
      ? g.settleAuthority.equals(authorityPda()) && g.studioBps === input.studioBps && g.studioRecipient.equals(input.studioAccount)
        ? "registered"
        : `registered with other terms (settle ${short(g.settleAuthority)}, ${g.studioBps} bps to ${short(g.studioRecipient)}): change them with propose_game_change (7 days)`
      : "no GameRecord",
    after: [],
    creates: [GAME_RECORD_SPACE],
  });
  const hash = facts.program?.hash ?? Buffer.alloc(32);
  const listed = !!g && g.listedUntil > input.now && facts.program !== null && g.approvedSlot === facts.program.slot && g.approvedHash.equals(hash);
  const until = input.now + input.listedDays * 86_400;
  add({
    id: "list-game",
    title: `tesoro_core list_game: the build deployed now (hash ${hash.toString("hex").slice(0, 16)}…) until ${new Date(until * 1000).toISOString().slice(0, 10)}`,
    why: "an unlisted Game's cars earn no Points, get no sponsored SOL and cannot be Backed; 365 days as the other four Games",
    signer: "admin",
    layer: "base",
    // list_game hashes the whole deployed program (about 1.1M CU for a 900 KB build).
    cu: 1_400_000,
    ixs: [listGameIx(input.admin, until, hash)],
    status: listed ? "done" : "to do",
    note: listed ? `listed until ${new Date(g!.listedUntil * 1000).toISOString().slice(0, 10)}` : g && g.listedUntil > 0 ? "listed for another build, or expired" : "not listed",
    after: ["register-game"],
  });
  const approved = facts.approvedValidators;
  const onlyTee = !!approved && approved.length === 1 && approved[0].equals(validator);
  add({
    id: "tee-only",
    title: `delegation program whitelist_validator_for_program: Railcar's accounts delegate only to the TEE validator ${short(validator)}`,
    why: "the four live Games approve only the TEE validator (F-01): a Table delegated anywhere else would run outside the private rollup",
    signer: "upgrade authority",
    layer: "base",
    ixs: [whitelistValidatorIx(input.upgradeAuthority, validator)],
    status: onlyTee ? "done" : approved && approved.some((v) => v.equals(validator)) ? "blocked" : "to do",
    note: !approved ? "no p-conf" : onlyTee ? "approved: the TEE validator only" : `approves ${approved.map(short).join(", ")}: remove the others with keeper/scripts/whitelist-tee.ts --remove`,
    after: [],
    creates: [PROGRAM_CONFIG_SPACE],
  });

  // 2. Railcar's config.
  const c = facts.config;
  const sameConfig = !!c && c.operator.equals(operator) && c.tables === input.tables;
  const tablesFixed = !!c && c.nextCar > 0n && c.tables !== input.tables;
  add({
    id: "set-config",
    title: `railcar set_config: operator ${short(operator)}, ${input.tables} Tables`,
    why: "names who runs the Tables and how many there are (a car rides on Table car_no % tables). Entry 500, 5-100 seats, the 30 s countdown, the refund schedule and the 60/25/15 split are program constants, and VRF and the TEE validator are pinned in the program",
    signer: "upgrade authority",
    layer: "base",
    ixs: [setConfigIx(input.upgradeAuthority, operator, input.tables)],
    status: sameConfig ? "done" : tablesFixed ? "blocked" : "to do",
    note: !c ? "no Config" : sameConfig ? "set" : tablesFixed ? `${c.tables} Tables, fixed since car 0 opened` : `operator ${short(c.operator)}, ${c.tables} Tables: will be replaced`,
    after: [],
    creates: c ? [] : [CONFIG_SPACE],
  });

  // 3. Sponsor and Fuel.
  add({
    id: "create-sponsor",
    title: `railcar create_sponsor: ${Number(input.sponsorLamports) / 1e9} SOL`,
    why: "the Sponsor pays each ride's commit on the rollup (25 free, then 100,000 lamports each)",
    signer: "operator",
    layer: "base",
    ixs: [createSponsorIx(operator, input.sponsorLamports)],
    status: facts.sponsor === "missing" ? "to do" : "done",
    note: facts.sponsor === "missing" ? "no Sponsor" : `exists (${facts.sponsor})`,
    after: ["set-config"],
    creates: [SPONSOR_SPACE],
    funds: input.sponsorLamports,
  });
  add({
    id: `create-fuel-${input.fuel}`,
    title: `railcar create_fuel ${input.fuel}: ${Number(input.fuelLamports) / 1e9} SOL`,
    why: "a reserve the operator moves into the Sponsor inside the rollup (refill_sponsor) without undelegating it",
    signer: "operator",
    layer: "base",
    ixs: [createFuelIx(operator, input.fuel, input.fuelLamports)],
    status: facts.fuel === "missing" ? "to do" : "done",
    note: facts.fuel === "missing" ? "no Fuel" : `exists (${facts.fuel})`,
    after: ["set-config"],
    creates: [FUEL_SPACE],
    funds: input.fuelLamports,
  });
  add({
    id: "delegate-sponsor",
    title: `railcar delegate_sponsor to ${short(validator)}`,
    why: "the commits run on the rollup, so the Sponsor that pays them lives there",
    signer: "operator",
    layer: "base",
    ixs: [delegateSponsorIx(operator, validator)],
    status: facts.sponsor === "delegated" ? "done" : "to do",
    note: facts.sponsor === "delegated" ? "delegated" : "not delegated",
    after: ["create-sponsor", "tee-only"],
    creates: delegation(Buffer.from("sponsor")),
  });
  add({
    id: `delegate-fuel-${input.fuel}`,
    title: `railcar delegate_fuel ${input.fuel} to ${short(validator)}`,
    why: "refill_sponsor runs on the rollup and moves lamports between two delegated accounts",
    signer: "operator",
    layer: "base",
    ixs: [delegateFuelIx(operator, input.fuel, validator)],
    status: facts.fuel === "delegated" ? "done" : "to do",
    note: facts.fuel === "delegated" ? "delegated" : "not delegated",
    after: [`create-fuel-${input.fuel}`, "tee-only"],
    creates: delegation(Buffer.from("fuel"), Uint8Array.of(input.fuel)),
  });

  // 4. Tables.
  for (const t of facts.tables) {
    const seeds = [Buffer.from("table"), le(t.index, 2)];
    add({
      id: `create-table-${t.index}`,
      title: `railcar create_table ${t.index} (${short(tablePda(t.index))}), funded ${Number(TABLE_BUFFER_LAMPORTS) / 1e9} SOL for its Vault`,
      why: "one car rides on one Table; with two, the next car boards and rides while the last one settles",
      signer: "operator",
      layer: "base",
      ixs: [createTableIx(operator, t.index)],
      status: t.base === "missing" ? "to do" : "done",
      note: t.base === "missing" ? "no Table" : `exists (${t.base})`,
      after: ["set-config"],
      creates: [TABLE_SPACE],
      funds: TABLE_BUFFER_LAMPORTS,
    });
    add({
      id: `delegate-table-${t.index}`,
      title: `railcar delegate_table ${t.index} to ${short(validator)}`,
      why: "the ride (draw, Jumps, Brakes, Impact) runs on the private rollup; the Table commits itself back at the end",
      signer: "operator",
      layer: "base",
      ixs: [delegateTableIx(operator, t.index, validator)],
      status: t.base === "delegated" ? "done" : "to do",
      note: t.base === "delegated" ? "delegated" : "not delegated",
      after: [`create-table-${t.index}`, "tee-only"],
      creates: delegation(...seeds),
    });
  }

  // 5. Vaults, on the rollup.
  for (const t of facts.tables) {
    add({
      id: `init-vault-${t.index}`,
      title: `railcar init_vault for Table ${t.index}: Vault ${short(vaultPda(tablePda(t.index)))}, private permission with no member`,
      why: "the draw, the crash point and the Brake schedule live there, readable by nobody during a ride; start_ride refuses a Table without it",
      signer: "operator",
      layer: "rollup",
      cu: 400_000,
      ixs: [initVaultIx(operator, t.index)],
      status: t.vaultReady ? "done" : "to do",
      note: t.vaultReady ? "Vault ready" : t.vaultReady === false ? "the rollup's Table has no Vault" : t.base === "delegated" ? "not read on the rollup" : "the Table is not on the rollup yet",
      after: [`delegate-table-${t.index}`],
    });
  }
  return steps;
}

const railcarNames = idlIxBuilder(railcarIdl as { address: string; instructions: unknown[] });
const WHITELIST_ACCOUNTS = ["authority", "validator", "program", "program_data", "delegation_program_data", "program_config", "system_program"];

/** The instruction's name and its accounts by their IDL names, for a printout. */
export function describeIx(ix: TransactionInstruction): { name: string; accounts: { name: string; key: PublicKey; signer: boolean; writable: boolean }[] } {
  const spec = (idl: { instructions: { name: string; accounts: { name: string }[] }[] }, name: string | null) => idl.instructions.find((i) => i.name === name)?.accounts.map((a) => a.name) ?? [];
  let name = "?";
  let names: string[] = [];
  if (ix.programId.equals(RAILCAR_PROGRAM_ID)) {
    name = railcarNames.nameOf(ix.data) ?? "?";
    names = spec(railcarIdl as never, name);
  } else if (ix.programId.equals(TESORO_CORE)) {
    name = coreIxName(ix) ?? "?";
    names = spec(coreIdl as never, name);
  } else if (ix.programId.equals(DELEGATION_PROGRAM_ID)) {
    name = "whitelist_validator_for_program";
    names = WHITELIST_ACCOUNTS;
  }
  return { name, accounts: ix.keys.map((k, i) => ({ name: names[i] ?? `#${i}`, key: k.pubkey, signer: k.isSigner, writable: k.isWritable })) };
}

/** Steps still to send, with the ones each needs that are not on chain yet in front: what a dry run simulates for it. */
export function withPending(steps: SetupStep[], step: SetupStep): SetupStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: SetupStep[] = [];
  const visit = (s: SetupStep) => {
    for (const id of s.after) {
      const dep = byId.get(id);
      if (dep && dep.status !== "done" && !out.includes(dep)) visit(dep);
    }
    if (!out.includes(s)) out.push(s);
  };
  visit(step);
  return out;
}
