// Solana-native Position flow for tesoro_core + the SIMULATED simSOL pool (sim_lst):
// faucet -> open -> advance -> crank -> redeem -> unlock (-> sweep). For the keeper and demos.
// Simulated yield: 1 month = ~10 min. No IDL needed: instructions are encoded by hand.
import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

export const TESORO_CORE_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const SIM_LST_ID = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
const YEAR = 31_536_000n;

const pda = (seeds: (Buffer | Uint8Array)[], program = TESORO_CORE_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const s = (x: string) => Buffer.from(x);
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

export const POOL = pda([s("pool")], SIM_LST_ID);
export const SIM_SOL_MINT = pda([s("mint")], SIM_LST_ID);
export const CONFIG = pda([s("config")]);
export const PRICE_FEED = pda([s("price"), SIM_SOL_MINT.toBuffer()]);

export const accountPda = (authority: PublicKey) => pda([s("account"), authority.toBuffer()]);
/** Same derivation as `native_position_id` on chain. */
export const positionId = (owner: PublicKey, nonce: bigint | number) =>
  createHash("sha256")
    .update(Buffer.concat([s("native"), owner.toBuffer(), u64(nonce)]))
    .digest();
export const positionPda = (owner: PublicKey, nonce: bigint | number) =>
  pda([s("position"), Buffer.from([0]), positionId(owner, nonce)]);
export const custodyPda = (position: PublicKey) => pda([s("native"), position.toBuffer()]);
export const vaultPda = (position: PublicKey) => pda([s("native_vault"), position.toBuffer()]);
export const sourcePda = (position: PublicKey, index: number) => {
  const i = Buffer.alloc(4);
  i.writeUInt32LE(index);
  return pda([s("source"), position.toBuffer(), i]);
};
export const holdingPda = (account: PublicKey, source: PublicKey) =>
  pda([s("holding"), account.toBuffer(), source.toBuffer()]);

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});
const ix = (keys: AccountMeta[], name: string, ...args: Buffer[]) =>
  new TransactionInstruction({
    programId: TESORO_CORE_ID,
    keys,
    data: Buffer.concat([disc(name), ...args]),
  });

const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(SIM_SOL_MINT, owner);

// --- Instruction builders -----------------------------------------------------------------

export function faucetIx(user: PublicKey) {
  const claim = pda([s("faucet"), user.toBuffer()], SIM_LST_ID);
  return new TransactionInstruction({
    programId: SIM_LST_ID,
    keys: [
      meta(user, true, true),
      meta(POOL),
      meta(SIM_SOL_MINT, true),
      meta(ata(user), true),
      meta(claim, true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: disc("faucet"),
  });
}

export const createAccountIx = (authority: PublicKey) =>
  ix(
    [meta(authority, true, true), meta(accountPda(authority), true), meta(SystemProgram.programId)],
    "create_account",
    Buffer.alloc(20),
  );

/** Oracle authority publishes the SOL/USD issuance price (micro-USD per SOL). Devnet stand-in for Pyth. */
export const setPriceIx = (oracle: PublicKey, priceMicroUsd: bigint) =>
  ix(
    [meta(oracle, true, true), meta(CONFIG), meta(PRICE_FEED, true), meta(SystemProgram.programId)],
    "set_price",
    u64(priceMicroUsd),
  );

export function openNativePositionIx(owner: PublicKey, nonce: bigint | number, lstAmount: bigint) {
  const position = positionPda(owner, nonce);
  return ix(
    [
      meta(owner, true, true),
      meta(accountPda(owner)),
      meta(POOL),
      meta(SIM_SOL_MINT),
      meta(ata(owner), true),
      meta(position, true),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "open_native_position",
    u64(nonce),
    u64(lstAmount),
  );
}

export function takeNativeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number) {
  const source = sourcePda(position, advances);
  return ix(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(PRICE_FEED),
      meta(source, true),
      meta(holdingPda(accountPda(owner), source), true),
      meta(SystemProgram.programId),
    ],
    "take_native_advance",
    Buffer.from([months]),
  );
}

/** Permissionless. `openAdvance` is the Position's open Advance index, if any. */
export const accrueNativeYieldIx = (position: PublicKey, openAdvance: number | null) =>
  ix(
    [
      meta(position, true),
      meta(custodyPda(position)),
      meta(vaultPda(position)),
      meta(POOL),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
    ],
    "accrue_native_yield",
  );

const payoutRemaining = (position: PublicKey, dest: PublicKey): AccountMeta[] => [
  meta(custodyPda(position), true),
  meta(vaultPda(position), true),
  meta(dest, true),
  meta(POOL),
  meta(TOKEN_PROGRAM_ID),
];

/** Redeem Gemas of `source`: the holder is paid simSOL into their own token account. */
export function redeemIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint) {
  const account = accountPda(holder);
  const i = ix(
    [
      meta(holder, false, true),
      meta(account, true),
      meta(position),
      meta(source, true),
      meta(holdingPda(account, source), true),
    ],
    "redeem",
    u64(gemas),
  );
  i.keys.push(...payoutRemaining(position, ata(holder)));
  return i;
}

/** Debt must be zero. Returns the Principal shares (minus yield still owed to holders) to the owner. */
export function unlockIx(owner: PublicKey, position: PublicKey) {
  const i = ix([meta(owner, false, true), meta(accountPda(owner)), meta(position, true)], "unlock");
  i.keys.push(...payoutRemaining(position, ata(owner)));
  return i;
}

export const sweepNativeSurplusIx = (owner: PublicKey, position: PublicKey) =>
  ix(
    [
      meta(owner, false, true),
      meta(accountPda(owner)),
      meta(position),
      meta(custodyPda(position)),
      meta(vaultPda(position), true),
      meta(ata(owner), true),
      meta(POOL),
      meta(TOKEN_PROGRAM_ID),
    ],
    "sweep_native_surplus",
  );

// --- State readers --------------------------------------------------------------------------

export interface PositionView {
  owner: PublicKey;
  principal: bigint;
  status: "Locked" | "Unlocked";
  advances: number;
  openAdvance: number | null;
  cumulativeYield: bigint;
  freeYield: bigint;
}

export async function readPosition(c: Connection, position: PublicKey): Promise<PositionView | null> {
  const info = await c.getAccountInfo(position, "confirmed");
  if (!info) return null;
  const d = Buffer.from(info.data);
  let o = 8 + 1 + 32; // discriminator, bump, position_id
  const owner = new PublicKey(d.subarray(o, o + 32));
  o += 32 + 1 + 32 + 1; // owner, chain, asset, decimals
  const principal = d.readBigUInt64LE(o);
  o += 8 + 2; // principal, rate_bps
  const status = d[o] === 0 ? "Locked" : "Unlocked";
  o += 1;
  const advances = d.readUInt32LE(o);
  o += 4;
  const openAdvance = d[o] === 1 ? d.readUInt32LE(o + 1) : null;
  o += (d[o] === 1 ? 5 : 1) + 8; // open_advance (Borsh Option), last_seq
  const cumulativeYield = d.readBigUInt64LE(o);
  const freeYield = d.readBigUInt64LE(o + 8);
  return { owner, principal, status, advances, openAdvance, cumulativeYield, freeYield };
}

export interface SourceView {
  index: number;
  horizonMonths: number;
  issued: bigint;
  returned: bigint;
  redeemed: bigint;
  yieldUnits: bigint;
  debt: bigint;
  /** Gemas repaid by yield but not yet redeemed. */
  redeemable: bigint;
  outstanding: bigint;
}

export async function readSource(c: Connection, source: PublicKey): Promise<SourceView | null> {
  const info = await c.getAccountInfo(source, "confirmed");
  if (!info) return null;
  const d = Buffer.from(info.data);
  let o = 8 + 1 + 32 + 32;
  const index = d.readUInt32LE(o);
  const horizonMonths = d[o + 4];
  o += 5;
  const num = d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
  const den = d.readBigUInt64LE(o + 16);
  o += 24;
  const issued = d.readBigUInt64LE(o);
  const returned = d.readBigUInt64LE(o + 8);
  const redeemed = d.readBigUInt64LE(o + 16);
  const yieldUnits = d.readBigUInt64LE(o + 24);
  const live = issued - returned;
  const byYield = (yieldUnits * den) / num;
  const covered = byYield < live ? byYield : live;
  return {
    index,
    horizonMonths,
    issued,
    returned,
    redeemed,
    yieldUnits,
    debt: live - covered,
    redeemable: covered - redeemed,
    outstanding: live - redeemed,
  };
}

/** Free Gemas the Account holds of a Source. */
export async function readHolding(c: Connection, holding: PublicKey): Promise<bigint> {
  const info = await c.getAccountInfo(holding, "confirmed");
  if (!info) return 0n;
  const d = Buffer.from(info.data);
  const base = 8 + 1 + 32 + 32 + 1;
  return d.readBigUInt64LE(base) - d.readBigUInt64LE(base + 8);
}

/** What `held` free Gemas of a Source may redeem now (pro rata, floor), as the program computes it. */
export function redeemableFor(src: SourceView, held: bigint): bigint {
  if (src.outstanding === 0n) return 0n;
  const share = (held * src.redeemable) / src.outstanding;
  return share < held ? share : held;
}

export async function readRate(c: Connection): Promise<bigint> {
  const info = await c.getAccountInfo(POOL, "confirmed");
  if (!info) throw new Error("sim_lst pool not initialized");
  const d = Buffer.from(info.data);
  const baseRate = d.readBigUInt64LE(72);
  const baseTs = d.readBigInt64LE(80);
  const apy = BigInt(d.readUInt32LE(88));
  const speedup = BigInt(d.readUInt32LE(92));
  const now = BigInt((await c.getBlockTime(await c.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000));
  const elapsed = now > baseTs ? now - baseTs : 0n;
  return baseRate + (baseRate * apy * elapsed * speedup) / (10_000n * YEAR);
}

export async function simSolBalance(c: Connection, owner: PublicKey): Promise<bigint> {
  try {
    const r = await c.getTokenAccountBalance(ata(owner), "confirmed");
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

// --- Flow -----------------------------------------------------------------------------------

export async function send(c: Connection, payer: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...extra);
  const sig = await c.sendRawTransaction(tx.serialize());
  await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

export async function ensureAccount(c: Connection, user: Keypair): Promise<string | null> {
  if (await c.getAccountInfo(accountPda(user.publicKey), "confirmed")) return null;
  return send(c, user, [createAccountIx(user.publicKey)]);
}

/** Open the Position and take its first Advance in one transaction (the owner signs alone). */
export async function openWithAdvance(
  c: Connection,
  user: Keypair,
  nonce: bigint | number,
  lstAmount: bigint,
  months: number,
) {
  const position = positionPda(user.publicKey, nonce);
  return send(c, user, [
    openNativePositionIx(user.publicKey, nonce, lstAmount),
    takeNativeAdvanceIx(user.publicKey, position, 0, months),
  ]);
}

/** Anyone can crank; `payer` only pays the fee. */
export async function crank(c: Connection, payer: Keypair, position: PublicKey) {
  const view = await readPosition(c, position);
  if (!view) throw new Error("position not found");
  return send(c, payer, [accrueNativeYieldIx(position, view.openAdvance)]);
}

/** Redeems everything currently redeemable on the Position's latest Advance. */
export async function redeemAll(c: Connection, holder: Keypair, position: PublicKey) {
  const view = await readPosition(c, position);
  if (!view || view.advances === 0) throw new Error("no advance");
  const source = sourcePda(position, view.advances - 1);
  const src = await readSource(c, source);
  if (!src) throw new Error("source not found");
  const held = await readHolding(c, holdingPda(accountPda(holder.publicKey), source));
  const amount = redeemableFor(src, held);
  if (amount === 0n) throw new Error("nothing redeemable yet");
  return { amount, sig: await send(c, holder, [redeemIx(holder.publicKey, position, source, amount)]) };
}

export const unlock = (c: Connection, owner: Keypair, position: PublicKey) =>
  send(c, owner, [unlockIx(owner.publicKey, position)]);
export const sweep = (c: Connection, owner: Keypair, position: PublicKey) =>
  send(c, owner, [sweepNativeSurplusIx(owner.publicKey, position)]);
