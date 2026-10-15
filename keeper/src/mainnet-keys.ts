/**
 * Plan for moving Tesoro's authorities behind a Squads v4 multisig (ticket 36, docs/mainnet-keys.md). Pure: builds the
 * instructions and commands, sends nothing. `keeper/scripts/mainnet-keys.ts` prints them and, only with `--execute`,
 * sends the Solana steps that the current (single) authority signs.
 */
import { createHash } from "node:crypto";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const LZ_ENDPOINT = new PublicKey("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
export const SQUADS_V4 = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

/** Program ids in this repo (devnet ids; mainnet ids are passed with --program name=ID when they differ). */
export const PROGRAMS = {
  tesoro_core: "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh",
  block_puzzle: "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj",
  holdem: "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE",
  trading_duel: "CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj",
  tesoro_bridge: "5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ",
  sim_lst: "WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F",
} as const;
export type ProgramName = keyof typeof PROGRAMS;
/** sim_lst is test mode only (ADR 0010); it is planned only with `includeSimLst`. */
export const MAINNET_PROGRAMS: ProgramName[] = ["tesoro_core", "block_puzzle", "holdem", "trading_duel", "tesoro_bridge"];

export interface PlanInput {
  /** The Squads vault PDA (vault index 0) that becomes upgrade authority, admin and fee recipient. */
  vault: PublicKey;
  /** The single key that holds every authority today (the signer of the "current" steps). */
  current: PublicKey;
  /** New tesoro_core `oracle_authority`: price, take_advance co-sign and Season record/pay. */
  oracle: PublicKey;
  /** tesoro_core platform fee; `update_config` replaces it, so it is stated, never guessed. */
  platformBps: number;
  /** New Invite key (ADR 0011): the plan adds the `set_invite_gate` step that turns the gate on with it. */
  invite?: PublicKey;
  programs?: Partial<Record<ProgramName, string>>;
  includeSimLst?: boolean;
  /** EVM vaults to hand over: chain label, vault address, new owner (a Safe or the owner address). */
  evm?: { chain: "ethereum" | "hyperevm"; vault: string; rpc: string; newOwner: string }[];
}

export type Signer = "current" | "vault";
export interface SolanaStep {
  kind: "solana";
  id: string;
  title: string;
  signer: Signer;
  why: string;
  ix: TransactionInstruction;
  /** The equivalent CLI command, when one exists. */
  cli?: string;
}
export interface EvmStep {
  kind: "evm";
  id: string;
  title: string;
  why: string;
  chain: string;
  /** Run by the CURRENT owner of the EVM contract (cast; never in this script). */
  command: string;
}
export interface NoteStep {
  kind: "note";
  id: string;
  title: string;
  why: string;
}
export type Step = SolanaStep | EvmStep | NoteStep;

const coder = new BorshInstructionCoder(coreIdl as Idl);

const pda = (programId: PublicKey, seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

function programData(programId: PublicKey): PublicKey {
  return pda(BPF_LOADER_UPGRADEABLE, [programId.toBuffer()]);
}

/** BPFLoaderUpgradeable::SetAuthority (tag 4). The unchecked form: the new authority is a PDA and cannot sign. */
export function setUpgradeAuthorityIx(program: PublicKey, current: PublicKey, next: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(4);
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [meta(programData(program), false, true), meta(current, true, false), meta(next, false, false)],
    data,
  });
}

export function coreConfigPda(core: PublicKey): PublicKey {
  return pda(core, [Buffer.from("config")]);
}

/** The Account (TesoroAccount) that receives the Platform Fee: `["account", authority]`. */
export function coreAccountPda(core: PublicKey, authority: PublicKey): PublicKey {
  return pda(core, [Buffer.from("account"), authority.toBuffer()]);
}

export function updateConfigIx(core: PublicKey, admin: PublicKey, oracle: PublicKey, platformBps: number, platformRecipient: PublicKey) {
  return new TransactionInstruction({
    programId: core,
    keys: [meta(admin, true, false), meta(coreConfigPda(core), false, true), meta(platformRecipient, false, false)],
    data: coder.encode("update_config", { oracle_authority: oracle, platform_bps: platformBps }),
  });
}

/** tesoro_core `set_invite_gate` (ADR 0011): admin only; while `required`, `create_account` needs `key` as a co-signer. */
export function setInviteGateIx(core: PublicKey, admin: PublicKey, required: boolean, key: PublicKey) {
  return new TransactionInstruction({
    programId: core,
    keys: [meta(admin, true, true), meta(coreConfigPda(core), false, false), meta(pda(core, [Buffer.from("invite_gate")]), false, true), meta(SystemProgram.programId, false, false)],
    data: coder.encode("set_invite_gate", { required, key }),
  });
}

export function coreSetAdminIx(core: PublicKey, upgradeAuthority: PublicKey, newAdmin: PublicKey) {
  return new TransactionInstruction({
    programId: core,
    keys: [meta(upgradeAuthority, true, false), meta(coreConfigPda(core), false, true), meta(core, false, false), meta(programData(core), false, false)],
    data: coder.encode("set_admin", { new_admin: newAdmin }),
  });
}

/** tesoro_bridge `set_admin`: moves Store.admin and the LayerZero OApp delegate; gated on the upgrade authority. */
export function bridgeSetAdminIx(bridge: PublicKey, upgradeAuthority: PublicKey, newAdmin: PublicKey) {
  const store = pda(bridge, [Buffer.from("Store")]);
  const registry = pda(LZ_ENDPOINT, [Buffer.from("OApp"), store.toBuffer()]);
  const eventAuthority = pda(LZ_ENDPOINT, [Buffer.from("__event_authority")]);
  return new TransactionInstruction({
    programId: bridge,
    keys: [
      meta(upgradeAuthority, true, false),
      meta(store, false, true),
      meta(bridge, false, false),
      meta(programData(bridge), false, false),
      // remaining accounts: the endpoint's set_delegate CPI, in the order set_admin.rs documents
      meta(LZ_ENDPOINT, false, false),
      meta(store, false, false),
      meta(registry, false, true),
      meta(eventAuthority, false, false),
      meta(LZ_ENDPOINT, false, false),
    ],
    data: anchorData("set_admin", newAdmin.toBuffer()),
  });
}

function anchorData(name: string, args: Buffer): Buffer {
  return Buffer.concat([createHash("sha256").update(`global:${name}`).digest().subarray(0, 8), args]);
}


export function buildPlan(input: PlanInput): Step[] {
  const ids = Object.fromEntries(
    (Object.keys(PROGRAMS) as ProgramName[]).map((n) => [n, new PublicKey(input.programs?.[n] ?? PROGRAMS[n])]),
  ) as Record<ProgramName, PublicKey>;
  const { vault, current } = input;
  if (vault.equals(current)) throw new Error("--vault and --current are the same key: the multisig vault must be a different address");
  if (input.oracle.equals(current) || input.oracle.equals(vault)) throw new Error("--oracle must be its own hot key: not the current deployer and not the vault");
  if (input.invite && [current, vault, input.oracle].some((k) => k.equals(input.invite!))) throw new Error("--invite must differ from the deployer, the vault and the oracle");
  if (!Number.isInteger(input.platformBps) || input.platformBps < 0 || input.platformBps > 10_000) throw new Error("--platform-bps must be an integer from 0 to 10000");

  const core = ids.tesoro_core;
  const feeAccount = coreAccountPda(core, vault);
  const steps: Step[] = [];

  steps.push({
    kind: "note",
    id: "0",
    title: "Before anything: the vault's Account must exist",
    why:
      `Platform fees go to the TesoroAccount ${feeAccount.toBase58()} (seeds ["account", vault]). It is created by create_account signed by the vault, ` +
      "so make a Squads proposal for it first, and create it BEFORE the Invite gate (ADR 0011) is switched on, or have the Invite key co-sign. " +
      "Fund the vault with a little SOL for rent. Then run the steps below in order.",
  });
  steps.push({
    kind: "solana",
    id: "1",
    title: "tesoro_core: set the oracle key and point the fee recipient at the vault's Account",
    signer: "current",
    why: "update_config replaces oracle_authority, platform_bps and platform_recipient together. Done first, while the current key is still admin.",
    ix: updateConfigIx(core, current, input.oracle, input.platformBps, feeAccount),
  });
  steps.push({
    kind: "solana",
    id: "2",
    title: "tesoro_core: rotate Config.admin to the vault",
    signer: "current",
    why: "set_admin is signed by the program's UPGRADE AUTHORITY, not the admin. Do it before step 5 moves the upgrade authority, or the vault must sign it.",
    ix: coreSetAdminIx(core, current, vault),
  });
  steps.push({
    kind: "solana",
    id: "3",
    title: "tesoro_bridge: rotate Store.admin and the LayerZero delegate to the vault",
    signer: "current",
    why: "set_admin on the bridge moves the admin and, in the same call, the endpoint delegate (peers, DVN and executor config). Also gated on the upgrade authority.",
    ix: bridgeSetAdminIx(ids.tesoro_bridge, current, vault),
  });

  if (input.invite) {
    steps.push({
      kind: "solana",
      id: "4",
      title: "tesoro_core: turn the Invite gate on with the Invite key",
      signer: "vault",
      why:
        `set_invite_gate(required = true, key = ${input.invite.toBase58()}) is admin only, and step 2 made the vault the admin, so this is a Squads proposal. ` +
        `Send it only AFTER the vault's own Account ${feeAccount.toBase58()} exists (step 0): once the gate is on, create_account needs the Invite key's co-signature. ` +
        "Turning the gate off at public launch is the same instruction with required = false.",
      ix: setInviteGateIx(core, vault, true, input.invite),
    });
  }

  const names = [...MAINNET_PROGRAMS, ...(input.includeSimLst ? (["sim_lst"] as ProgramName[]) : [])];
  let n = 5;
  for (const name of names) {
    const id = ids[name];
    steps.push({
      kind: "solana",
      id: String(n++),
      title: `${name}: upgrade authority to the vault`,
      signer: "current",
      why: "Unchecked SetAuthority: the vault is a PDA and cannot sign, so the checked form (--final) is not usable. After this only the vault can upgrade or close the program.",
      ix: setUpgradeAuthorityIx(id, current, vault),
      cli: `solana program set-upgrade-authority ${id.toBase58()} --new-upgrade-authority ${vault.toBase58()} --skip-new-upgrade-authority-signer-check --keypair <CURRENT_KEYPAIR> --url <RPC>`,
    });
  }

  for (const e of input.evm ?? []) {
    steps.push({
      kind: "evm",
      id: String(n++),
      chain: e.chain,
      title: `${e.chain} vault ${e.vault}: LayerZero delegate, then owner, to ${e.newOwner}`,
      why:
        "PositionVaultOApp is Ownable (single step) and its owner is also the LayerZero delegate and the vault admin (Yield Fee, fundTreasury). setDelegate is onlyOwner, so it runs FIRST; " +
        "transferOwnership second. After that the Safe is the only way to change peers, the fee or LayerZero config. Check the new owner can sign (Safe deployed on that chain) before sending.",
      command: [
        `cast send ${e.vault} "setDelegate(address)" ${e.newOwner} --rpc-url ${e.rpc} --private-key "$CURRENT_OWNER_KEY"`,
        `cast send ${e.vault} "transferOwnership(address)" ${e.newOwner} --rpc-url ${e.rpc} --private-key "$CURRENT_OWNER_KEY"`,
        `cast call ${e.vault} "owner()(address)" --rpc-url ${e.rpc}   # expect ${e.newOwner}`,
      ].join("\n"),
    });
  }

  steps.push({
    kind: "note",
    id: String(n++),
    title: "Check",
    why:
      "For every program: `solana program show <ID>` shows Authority = the vault. Read Config (admin, oracle_authority, platform_recipient) and the bridge Store; " +
      "then make one harmless vault proposal (for example update_config with the same values) to prove the vault can still act. Only then retire the old deployer key.",
  });
  return steps;
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");

/** Text for one step: what it does, who signs, the accounts and data. */
export function describe(step: Step): string {
  const head = `[${step.id}] ${step.title}`;
  if (step.kind === "note") return `${head}\n    ${step.why}`;
  if (step.kind === "evm") return `${head}\n    ${step.why}\n    run by the current EVM owner:\n${step.command.split("\n").map((l) => `      ${l}`).join("\n")}`;
  const lines = [head, `    signer: ${step.signer === "current" ? "the CURRENT key (single signature)" : "the Squads vault (proposal)"}`, `    ${step.why}`, `    program: ${step.ix.programId.toBase58()}`];
  for (const k of step.ix.keys) lines.push(`      ${k.isSigner ? "signer  " : "        "}${k.isWritable ? "writable" : "readonly"} ${k.pubkey.toBase58()}`);
  lines.push(`    data (base64): ${b64(step.ix.data)}`);
  if (step.cli) lines.push(`    cli: ${step.cli}`);
  return lines.join("\n");
}
