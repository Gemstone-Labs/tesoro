/**
 * The tesoro_core launch init calls, in runbook order (ticket 44, docs/mainnet-runbook.md step T-7 5). Pure: builds every
 * instruction from the IDL (account order, signer and writable flags, PDAs, Borsh data) and sends nothing.
 * `keeper/scripts/launch-admin.ts` prints the plan and, only with `--execute`, sends the steps one single key signs.
 */
import anchor, { type Idl } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { PROGRAMS, type ProgramName } from "./mainnet-keys.ts";

const idl = coreIdl as unknown as { instructions: IdlIx[] };
const { BN, BorshInstructionCoder } = anchor;
const coder = new BorshInstructionCoder(coreIdl as unknown as Idl);

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
  pda?: { seeds: { kind: "const" | "account" | "arg"; value?: number[]; path?: string }[] };
}
interface IdlIx {
  name: string;
  accounts: IdlAccount[];
}

// ---- Constants documented for the launch -------------------------------------------------------------

/** Pyth price feed ids (Hermes `GET /v2/price_feeds`, checked 2026-10-16; https://pyth.network/developers/price-feed-ids). */
export const PYTH_FEED_IDS = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  HYPE: "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
} as const;
export type PriceAsset = keyof typeof PYTH_FEED_IDS;

/** Pyth sponsored push feeds: PDA `[u16 shard = 0, feed id]` of the push oracle; accounts are owned by the Pyth receiver. */
export const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const pythFeedAccount = (asset: PriceAsset) =>
  PublicKey.findProgramAddressSync([Buffer.from([0, 0]), Buffer.from(PYTH_FEED_IDS[asset], "hex")], PYTH_PUSH_ORACLE)[0];

export const JITOSOL_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
export const JITO_STAKE_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
/** The EVM token each real-token vault locks; the vault reports it as `bytes32(uint160(token))` and that is the Position's `source_asset`. */
export const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
export const KHYPE = "0xfD739d4e423301CE9385c1fb8850539D657C296D";
/** A 20-byte EVM address as the 32-byte Solana-side key the bridge stores (12 zero bytes, then the address). */
export function evmAssetKey(address: string): PublicKey {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
  return new PublicKey(Buffer.concat([Buffer.alloc(12), Buffer.from(address.slice(2), "hex")]));
}
/** `set_onchain_price` asset key per priced asset: jitoSOL mint, wstETH and kHYPE padded. */
export const PRICE_ASSET_KEYS: Record<PriceAsset, { label: string; key: PublicKey }> = {
  SOL: { label: `jitoSOL mint ${JITOSOL_MINT.toBase58()}`, key: JITOSOL_MINT },
  ETH: { label: `wstETH ${WSTETH} (Ethereum vault)`, key: evmAssetKey(WSTETH) },
  HYPE: { label: `kHYPE ${KHYPE} (HyperEVM vault)`, key: evmAssetKey(KHYPE) },
};
/** `SourceChain` bytes: Ethereum 1, HyperEVM 2. */
export const SOURCE_CHAINS = { ethereum: { byte: 1, variant: "Ethereum" }, hyperevm: { byte: 2, variant: "HyperEvm" } } as const;

export const STEP_NAMES = [
  "vault-account",
  "config",
  "treasury",
  "stake-token",
  "apy-ceiling",
  "prices",
  "entry-sizes",
  "games",
  "leaderboard",
  "company",
  "sources",
  "whitelist",
  "invite-gate",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

// ---- Instruction building from the IDL ---------------------------------------------------------------

const pda = (programId: PublicKey, seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = (core: PublicKey) => pda(core, [Buffer.from("config")]);
export const coreAccountPda = (core: PublicKey, authority: PublicKey) => pda(core, [Buffer.from("account"), authority.toBuffer()]);
export const gameAuthorityPda = (game: PublicKey) => pda(game, [Buffer.from("authority")]);

/**
 * One tesoro_core instruction: account order, signer and writable flags come from the IDL; `accounts` names the ones the
 * IDL cannot derive (signers, recipients, mints), PDAs and fixed addresses are derived. `args` are Borsh-encoded in IDL order.
 */
export function coreIx(core: PublicKey, name: string, accounts: Record<string, PublicKey>, args: Record<string, unknown> = {}, seedArgs: Record<string, PublicKey> = {}) {
  const def = idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`tesoro_core has no instruction ${name}`);
  const resolved: Record<string, PublicKey> = { ...accounts };
  const keys: AccountMeta[] = def.accounts.map((a) => {
    let key = resolved[a.name];
    if (!key && a.address) key = new PublicKey(a.address);
    if (!key && a.pda) {
      const seeds = a.pda.seeds.map((s) => {
        if (s.kind === "const") return Buffer.from(s.value!);
        if (s.kind === "account") {
          const ref = resolved[s.path!];
          if (!ref) throw new Error(`${name}: account ${a.name} is seeded by ${s.path}, which is not resolved`);
          return ref.toBuffer();
        }
        const arg = seedArgs[s.path!];
        if (!arg) throw new Error(`${name}: account ${a.name} is seeded by argument ${s.path}`);
        return arg.toBuffer();
      });
      key = pda(core, seeds);
    }
    if (!key) throw new Error(`${name}: account ${a.name} must be given`);
    resolved[a.name] = key;
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  const ix = new TransactionInstruction({ programId: core, keys, data: coder.encode(name, args) });
  ixNames.set(ix, def.accounts.map((a) => a.name));
  return ix;
}

/** IDL account names of an instruction built by `coreIx`, for the printout. */
export const ixNames = new WeakMap<TransactionInstruction, string[]>();

// ---- The plan ----------------------------------------------------------------------------------------

export interface GameInput {
  name: "block_puzzle" | "holdem" | "trading_duel";
  /** Wallet that owns the Studio's Account (it must exist before register_game: `create_account` by that wallet). */
  studio: PublicKey;
  studioBps: number;
}

export interface LaunchInput {
  /** `Config.admin` at the time of the run: the Deployer before the hand-over, the Squads vault after. */
  admin: PublicKey;
  /** The Squads vault PDA (vault index 0). */
  vault: PublicKey;
  programs?: Partial<Record<ProgramName, string>>;
  oracle?: PublicKey;
  platformBps?: number;
  yieldFeeBps?: number;
  instantFeeBps?: number;
  apyCeilingBps?: number;
  entrySizes?: number[];
  maxAgeSecs?: number;
  maxConfBps?: number;
  leaderboardBps?: number;
  games?: GameInput[];
  company?: PublicKey;
  invite?: PublicKey;
  /** EVM address linked to the vault's Account (default none). */
  vaultEvm?: string;
  steps?: StepName[];
}

export interface PlanStep {
  id: string;
  name: StepName | "note";
  title: string;
  why: string;
  /** Who must sign. Absent for a note. */
  signer?: PublicKey;
  /** True when `signer` is the Squads vault: it is a PDA, so the step is a Squads proposal and is never sent here. */
  proposal?: boolean;
  ixs: TransactionInstruction[];
  /** The ids of the values worth checking after the step. */
  check?: string;
}

const need = (missing: string[], cond: unknown, flag: string) => {
  if (!cond) missing.push(flag);
};

export function programIds(over: LaunchInput["programs"] = {}): Record<ProgramName, PublicKey> {
  return Object.fromEntries((Object.keys(PROGRAMS) as ProgramName[]).map((n) => [n, new PublicKey(over[n] ?? PROGRAMS[n])])) as Record<ProgramName, PublicKey>;
}

export function buildLaunchPlan(input: LaunchInput): PlanStep[] {
  const ids = programIds(input.programs);
  const core = ids.tesoro_core;
  const { admin, vault } = input;
  const selected = new Set<StepName>(input.steps?.length ? input.steps : STEP_NAMES);
  const on = (n: StepName) => selected.has(n);
  const multisig = admin.equals(vault);
  const yieldFee = input.yieldFeeBps ?? 2000;
  const instantFee = input.instantFeeBps ?? 2500;
  const ceiling = input.apyCeilingBps ?? 800;
  const sizes = input.entrySizes ?? [100, 500, 1000];
  const maxAge = input.maxAgeSecs ?? 90;
  const maxConf = input.maxConfBps ?? 100;
  const lbBps = input.leaderboardBps ?? 100;
  const games = input.games ?? [];

  const missing: string[] = [];
  if (on("config")) {
    need(missing, input.oracle, "--oracle");
    need(missing, input.platformBps !== undefined, "--platform-bps");
  }
  if (on("games")) need(missing, games.length > 0, "--game <name>=<studio wallet>[,<studio bps>]");
  if (on("company")) need(missing, input.company, "--company");
  if (on("invite-gate")) need(missing, input.invite, "--invite");
  if (missing.length) throw new Error(`missing for the selected steps: ${missing.join(", ")}`);

  const u16 = (n: number, flag: string) => {
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`${flag} must be an integer from 0 to 10000`);
    return n;
  };
  if (on("config")) u16(input.platformBps!, "--platform-bps");
  for (const [n, v] of [["--yield-fee-bps", yieldFee], ["--instant-fee-bps", instantFee], ["--leaderboard-bps", lbBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 5000) throw new Error(`${n} must be an integer from 0 to 5000`);
  }
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 2000) throw new Error("--apy-ceiling-bps must be an integer from 1 to 2000");
  if (sizes.length < 1 || sizes.length > 4 || new Set(sizes).size !== sizes.length || sizes.some((s) => !Number.isInteger(s) || s <= 0 || s % 100 !== 0)) {
    throw new Error("--entry-sizes must be 1 to 4 distinct positive multiples of 100");
  }
  if (input.oracle && [admin, vault].some((k) => k.equals(input.oracle!))) throw new Error("--oracle must be its own hot key: not the admin and not the vault");
  if (input.invite && [admin, vault, ...(input.oracle ? [input.oracle] : [])].some((k) => k.equals(input.invite!))) throw new Error("--invite must differ from the admin, the vault and the oracle");
  for (const g of games) u16(g.studioBps, `studio bps of ${g.name}`);

  const feeAccount = coreAccountPda(core, vault);
  const config = configPda(core);
  const steps: PlanStep[] = [];
  let n = 1;
  const add = (s: Omit<PlanStep, "id" | "proposal"> & { proposal?: boolean }) => {
    steps.push({ ...s, id: String(n++), proposal: s.signer ? s.signer.equals(vault) : undefined });
  };
  const adminSigns = (): { signer: PublicKey } => ({ signer: admin });

  if (on("vault-account")) {
    const evm = input.vaultEvm ? Buffer.from(input.vaultEvm.replace(/^0x/, ""), "hex") : Buffer.alloc(20);
    if (evm.length !== 20) throw new Error("--vault-evm must be a 20-byte EVM address");
    add({
      name: "vault-account",
      title: "tesoro_core: create the Squads vault's own Account (the fee recipient)",
      signer: vault,
      why:
        `create_account signed by the vault creates the TesoroAccount ${feeAccount.toBase58()} (["account", vault]); it receives the Platform Fee and must exist before initialize_config. ` +
        "The vault is a PDA and cannot sign a normal transaction: submit this as a Squads proposal, with the vault funded for rent. It does not need Config. " +
        "Do it BEFORE the Invite gate is on (the gate step is last); the gate account does not exist yet, so no Invite key is needed.",
      ixs: [coreIx(core, "create_account", { authority: vault, account: feeAccount }, { evm_address: [...evm] })],
      check: `account ${feeAccount.toBase58()} exists on tesoro_core`,
    });
  }

  if (on("config")) {
    add({
      name: "config",
      title: "tesoro_core: initialize_config (oracle key, Platform Fee, fee recipient = the vault's Account)",
      ...adminSigns(),
      why:
        "UPGRADE-AUTHORITY CAVEAT: initialize_config is not restricted to the upgrade authority. Whoever signs first becomes Config.admin, so anyone watching the chain could front-run the gap " +
        "between the deploy and this call. Run it in the SAME SESSION as the tesoro_core deploy, with the Deployer as --admin, then READ Config.admin and confirm it is the Deployer. " +
        "If it is anyone else, `set_admin` signed by the upgrade authority takes the admin back (docs/mainnet-keys.md, rotation steps). Needs the vault's Account from the first step to exist.",
      ixs: [coreIx(core, "initialize_config", { admin, platform_recipient: feeAccount }, { oracle_authority: input.oracle!, platform_bps: input.platformBps! })],
      check: `Config ${config.toBase58()}: admin = ${admin.toBase58()}, oracle_authority = ${input.oracle!.toBase58()}, platform_recipient = ${feeAccount.toBase58()}`,
    });
  }

  if (on("treasury")) {
    add({
      name: "treasury",
      title: `tesoro_core: init_treasury_stake(${yieldFee}, ${instantFee}) (Yield Fee ${yieldFee / 100}%, Instant Redeem Fee ${instantFee / 100}%)`,
      ...adminSigns(),
      why: "Creates the Treasury and its Account. Not init_treasury (that needs the simSOL mint). Do it before any Position exists: the Position copies the Yield Fee when it opens.",
      ixs: [coreIx(core, "init_treasury_stake", { admin }, { yield_fee_bps: yieldFee, instant_fee_bps: instantFee })],
      check: `Treasury exists with fees ${yieldFee} and ${instantFee}`,
    });
  }

  if (on("stake-token")) {
    add({
      name: "stake-token",
      title: "tesoro_core: set_stake_token (jitoSOL, Jito stake pool)",
      ...adminSigns(),
      why:
        `Mint ${JITOSOL_MINT.toBase58()} and stake pool ${JITO_STAKE_POOL.toBase58()} (the pool account is owned by SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy). ` +
        "Verify both addresses on a block explorer against Jito's published addresses before sending. Creates the StakeCustody and its token vault.",
      ixs: [coreIx(core, "set_stake_token", { admin, mint: JITOSOL_MINT, stake_pool: JITO_STAKE_POOL })],
      check: "StakeCustody.pool = the Jito pool; StakeConfig.active_mint = jitoSOL",
    });
  }

  if (on("apy-ceiling")) {
    add({
      name: "apy-ceiling",
      title: `tesoro_core: set_stake_apy_ceiling(${ceiling}) (${ceiling / 100}%)`,
      ...adminSigns(),
      why: "Without it no Advance is sized (StakeCeilingNotSet). Allowed range 1 to 2,000 bps; it cannot be set back to zero.",
      ixs: [coreIx(core, "set_stake_apy_ceiling", { admin }, { apy_ceiling_bps: ceiling })],
      check: `StakeConfig.apy_ceiling_bps = ${ceiling}`,
    });
  }

  if (on("prices")) {
    for (const asset of ["SOL", "ETH", "HYPE"] as PriceAsset[]) {
      const { label, key } = PRICE_ASSET_KEYS[asset];
      const feed = pythFeedAccount(asset);
      add({
        name: "prices",
        title: `tesoro_core: set_onchain_price for ${asset}/USD (asset key ${label})`,
        ...adminSigns(),
        why:
          `Maps the Position's source_asset ${key.toBase58()} to the Pyth sponsored push feed ${feed.toBase58()} (shard 0) with feed id ${PYTH_FEED_IDS[asset]} (Pyth Crypto.${asset}/USD). ` +
          `Limits: max age ${maxAge} s, confidence ${maxConf} bps. Check the feed account first: owner ${PYTH_RECEIVER.toBase58()}, 134 bytes, feed id at data bytes 41 to 72.`,
        ixs: [
          coreIx(core, "set_onchain_price", { admin, feed }, { asset: key, feed_id: [...Buffer.from(PYTH_FEED_IDS[asset], "hex")], max_age_secs: maxAge, max_conf_bps: maxConf }, { asset: key }),
        ],
        check: `OnchainPrice ["onchain_price", ${key.toBase58()}] exists with this feed`,
      });
    }
  }

  if (on("entry-sizes")) {
    add({
      name: "entry-sizes",
      title: `tesoro_core: set_entry_sizes([${sizes.join(", ")}])`,
      ...adminSigns(),
      why: "Unset means the test ladder 500 / 1,000 / 2,500, so this call is required on mainnet. The app mirrors the ladder in cluster-settings.ts; a mismatch breaks entry.",
      ixs: [coreIx(core, "set_entry_sizes", { admin }, { sizes: sizes.map((s) => new BN(s)) })],
      check: "Config.entry_sizes",
    });
  }

  if (on("games")) {
    for (const g of games) {
      const gameId = ids[g.name];
      const authority = gameAuthorityPda(gameId);
      add({
        name: "games",
        title: `tesoro_core: register_game ${g.name} (Studio Fee ${g.studioBps} bps)`,
        ...adminSigns(),
        why:
          `Game program ${gameId.toBase58()}, settlement authority = its ["authority"] PDA ${authority.toBase58()}. Studio recipient = the Account of ${g.studio.toBase58()} ` +
          `(${coreAccountPda(core, g.studio).toBase58()}); that wallet must have called create_account first. Platform + Studio + Leaderboard fees are capped at 50% together.`,
        ixs: [coreIx(core, "register_game", { admin, studio_recipient: coreAccountPda(core, g.studio) }, { game: gameId, authority, studio_bps: g.studioBps })],
        check: "Config.games lists the Game with this fee and recipient",
      });
    }
  }

  if (on("leaderboard")) {
    add({
      name: "leaderboard",
      title: `tesoro_core: init_leaderboard(${lbBps}) (Leaderboard Fee ${lbBps / 100}%)`,
      ...adminSigns(),
      why:
        "Extends Config, creates the Pool Account and sets the fee. There is no separate Season init: Season 1 starts at the program's fixed epoch (Monday 2026-10-05 00:00 UTC), so the first mainnet Season is whichever week the clock is in and is partial. " +
        "The oracle key (the keeper's season job) must be Config.oracle_authority.",
      ixs: [coreIx(core, "init_leaderboard", { admin }, { leaderboard_bps: lbBps })],
      check: `Config has a pool Account and leaderboard_bps ${lbBps}`,
    });
  }

  if (on("company")) {
    add({
      name: "company",
      title: "tesoro_core: set_treasury_company (wallet that withdraw_treasury_stake pays)",
      ...adminSigns(),
      why: `Names ${input.company!.toBase58()} as the Treasury's company wallet; needed once before any withdraw_treasury_stake. A founder decision.`,
      ixs: [coreIx(core, "set_treasury_company", { admin }, { company: input.company! })],
      check: "Treasury.company",
    });
  }

  if (on("sources")) {
    const bridgeAuthority = pda(ids.tesoro_bridge, [Buffer.from("authority")]);
    for (const [label, c] of Object.entries(SOURCE_CHAINS)) {
      const sourceAuthority = pda(core, [Buffer.from("source_auth"), Buffer.from([c.byte])]);
      add({
        name: "sources",
        title: `tesoro_core: set_source_authority ${label} -> the bridge authority`,
        ...adminSigns(),
        why:
          `The signer allowed to report Positions of ${label} (SourceChain byte ${c.byte}) is the tesoro_bridge ["authority"] PDA ${bridgeAuthority.toBase58()} of ${ids.tesoro_bridge.toBase58()}. ` +
          "Without it apply_locked cannot run. The bridge's own set_peer_config for each vault (eids 30101 and 30367) is a separate bridge call (bridge/scripts/lz.ts, docs/cross-chain.md).",
        ixs: [coreIx(core, "set_source_authority", { admin, source_authority: sourceAuthority }, { chain: { [c.variant]: {} }, authority: bridgeAuthority })],
        check: `SourceAuthority ${sourceAuthority.toBase58()} holds ${bridgeAuthority.toBase58()}`,
      });
    }
  }

  if (on("whitelist")) {
    add({
      name: "whitelist",
      title: "MagicBlock: approve only the TEE validator for each Game program (not a tesoro_core call)",
      why:
        "Run `keeper/scripts/whitelist-tee.ts <game program id> --rpc <url> --keypair <upgrade authority file> --validator <mainnet TEE validator>` per Game, signed by the program's upgrade authority " +
        "(the Deployer, before the upgrade authority moves to the vault). The mainnet TEE validator and endpoints are not confirmed yet (runbook blockers, item 1).",
      ixs: [],
    });
  }

  if (on("invite-gate")) {
    add({
      name: "invite-gate",
      title: "tesoro_core: set_invite_gate(true, Invite key) (LAST)",
      ...adminSigns(),
      why:
        `Turns the gate on with Invite key ${input.invite!.toBase58()} (ADR 0012). Once on, create_account needs the Invite key's co-signature, so run this only after every Account that must exist without an Invite ` +
        `(the vault's ${feeAccount.toBase58()}, founder wallets, Studio wallets, the Squads test) has been created. Admin only: after the hand-over the vault is the admin, so it is a Squads proposal. ` +
        "Turning the gate off at public launch is the same instruction with required = false.",
      ixs: [coreIx(core, "set_invite_gate", { admin }, { required: true, key: input.invite! })],
      check: "InviteGate.required = true with this key",
    });
  }

  const sendable = steps.filter((s) => s.signer && !s.proposal);
  if (multisig && steps.some((s) => s.signer)) {
    steps.push({ id: String(n++), name: "note", title: "Note", why: "--admin is the vault: every step above is a Squads proposal. Nothing here can be sent with --execute.", ixs: [] });
  } else if (sendable.length && steps.some((s) => s.proposal)) {
    steps.push({ id: String(n++), name: "note", title: "Note", why: "Steps signed by the vault are Squads proposals. --execute never sends them.", ixs: [] });
  }
  return steps;
}

// ---- Printing ----------------------------------------------------------------------------------------

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");

export function describeStep(step: PlanStep): string {
  const head = `[${step.id}] ${step.title}`;
  const lines = [head];
  if (step.signer) {
    lines.push(step.proposal ? `    signer: ${step.signer.toBase58()} = the Squads vault: SUBMIT AS A SQUADS PROPOSAL (never sent by this script)` : `    signer: ${step.signer.toBase58()} (single key: sent by --execute)`);
  }
  lines.push(`    ${step.why}`);
  for (const ix of step.ixs) {
    lines.push(`    program: ${ix.programId.toBase58()}`);
    const names = ixNames.get(ix) ?? [];
    ix.keys.forEach((k, i) => lines.push(`      ${k.isSigner ? "signer  " : "        "}${k.isWritable ? "writable" : "readonly"} ${(names[i] ?? "?").padEnd(18)} ${k.pubkey.toBase58()}`));
    lines.push(`    data (base64): ${b64(ix.data)}`);
  }
  if (step.check) lines.push(`    check after: ${step.check}`);
  return lines.join("\n");
}
