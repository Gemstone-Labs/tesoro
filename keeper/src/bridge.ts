import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import {
  BRIDGE,
  ENDPOINT_SETTINGS,
  STORE,
  applyLockedIx,
  applyYieldIx,
  corePositionPda,
  coreSourcePda,
  disc,
  chainByte,
  evmLinkPda,
  meta,
  peerPda,
  quoteFee,
  sendAccounts,
  sendParams,
} from "./lz.ts";
import { simulate } from "./tee.ts";
import { treasuryAccountPda } from "../../app/src/lib/chain/native.ts";
import anchor from "@coral-xyz/anchor";
import { bridgeDisc, decodeClaim, type ClaimRow } from "./bridge-ix.ts";
import { connReader, supplySources } from "./supply.ts";

const status = (o: object) => Object.keys(o)[0];

// Account sizes: 8-byte discriminator + `InitSpace` of the Anchor account (bridge/programs/tesoro_bridge/src/state).
const BRIDGE_POSITION_SIZE = 8 + 164 + 16 + 16 + 8; // `treasury_balance`, `instant_paid` (u128 each) and `report_time` (u64) sit at the end

export interface BridgePosition {
  key: PublicKey;
  eid: number;
  positionId: Uint8Array;
  lastInSeq: bigint;
  lockedSeq: bigint;
  ownerEvm: Uint8Array;
  opened: boolean;
  lastYieldSeq: bigint;
  appliedYieldSeq: bigint;
  unlockSent: boolean;
}

export function readBridgePosition(key: PublicKey, d: Buffer): BridgePosition {
  let o = 8;
  const rd = (n: number) => d.subarray(o, (o += n));
  const eid = rd(4).readUInt32LE(0);
  const positionId = Uint8Array.from(rd(32));
  rd(1);
  const lastInSeq = rd(8).readBigUInt64LE(0);
  const lockedSeq = rd(8).readBigUInt64LE(0);
  const ownerEvm = Uint8Array.from(rd(20));
  rd(32 + 16 + 1);
  const opened = rd(1)[0] === 1;
  const lastYieldSeq = rd(8).readBigUInt64LE(0);
  rd(16);
  const appliedYieldSeq = rd(8).readBigUInt64LE(0);
  rd(8);
  const unlockSent = rd(1)[0] === 1;
  return { key, eid, positionId, lastInSeq, lockedSeq, ownerEvm, opened, lastYieldSeq, appliedYieldSeq, unlockSent };
}

/** `<vault 0x…4 chars>#<vault position id>` for log lines. */
const label = (eid: number, id: Uint8Array) => {
  const vault = Buffer.from(id.subarray(0, 20)).toString("hex");
  return `eid=${eid} vault=0x${vault.slice(0, 6)}..${vault.slice(-4)}#${Buffer.from(id).readBigUInt64BE(20)}`;
};

const withCu = (units: number, ...ixs: TransactionInstruction[]) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs];

/** Callers simulate first (free): `sendBase` skips preflight, so a doomed transaction would still cost its fee. */
const sendChecked = (ctx: Ctx, ixs: TransactionInstruction[]) => ctx.bp.sendBase(ctx.signer, ixs);

/** Every BridgePosition record of the bridge program. */
export async function fetchBridgePositions(ctx: Ctx): Promise<BridgePosition[]> {
  const accts = await ctx.conn.getProgramAccounts(BRIDGE, { filters: [{ dataSize: BRIDGE_POSITION_SIZE }] });
  return accts.map((a) => readBridgePosition(a.pubkey, a.account.data));
}

/**
 * Job 5: Solana side of the LayerZero bridge (docs/cross-chain.md). Everything here is permissionless and
 * idempotent through the bridge's own tracking (`opened`, `applied_yield_seq`, `unlock_sent`, `Claim.units_sent`):
 *   - a delivered PositionLocked not yet applied: `apply_locked` (needs the owner's EvmLink; the keeper pays rent);
 *   - a delivered YieldAccrued newer than the applied one: `apply_yield`;
 *   - an unlocked Position (Debt zero) whose Unlock was not sent: `send_unlock`;
 *   - a redemption Claim with units not yet sent: `send_pay_yield`. The Treasury Account's own Claim (`redeem_treasury_to_evm`,
 *     see treasury.ts) is paid to the vault itself, so it carries no EvmLink.
 * The two sends cost a LayerZero fee in SOL from the keeper payer: capped per message and per hour.
 */
export async function bridgeJob(ctx: Ctx): Promise<number> {
  const byDisc = async (disc: Buffer): Promise<ClaimRow[]> =>
    (await ctx.conn.getProgramAccounts(BRIDGE, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }] })).map((a) => decodeClaim(a.pubkey, Buffer.from(a.account.data)));
  // Claim and InstantClaim have the same size, so they are told apart by their discriminator, never by size.
  const [positions, claims, instantClaims] = await Promise.all([fetchBridgePositions(ctx), byDisc(bridgeDisc.claim), byDisc(bridgeDisc.instantClaim)]);
  let actions = 0;
  let waiting = 0;

  const corePositions = new Map<string, any>();
  const corePosition = async (key: PublicKey) => {
    const hit = corePositions.get(key.toBase58());
    if (hit !== undefined) return hit;
    const p = await ctx.core.account.positionState.fetchNullable(key);
    corePositions.set(key.toBase58(), p);
    return p;
  };

  for (const p of positions) {
    const subject = `bridge ${label(p.eid, p.positionId)}`;
    try {
      const cpKey = corePositionPda(p.eid, p.positionId);

      // Delivered PositionLocked, not applied yet.
      if (p.lockedSeq > 0n && !p.opened) {
        const link = evmLinkPda(p.ownerEvm);
        const linkInfo = await ctx.conn.getAccountInfo(link);
        if (!linkInfo) {
          waiting++;
          log("bridge", subject, `wait: PositionLocked delivered, owner EVM address 0x${Buffer.from(p.ownerEvm).toString("hex")} is not linked to an Account yet`);
          continue;
        }
        const ownerAccount = new PublicKey(linkInfo.data.subarray(8 + 20, 8 + 52));
        const ixs = withCu(400_000, applyLockedIx(ctx.payer.publicKey, p.eid, p.positionId, link, ownerAccount));
        const err = await simulate(ctx.conn, ctx.payer, ixs);
        if (err) {
          waiting++;
          log("bridge", subject, `wait: apply_locked would fail (${err.slice(0, 160)})`);
        } else {
          actions += +(await act(ctx, "bridge", subject, `apply_locked (PositionLocked seq ${p.lockedSeq})`, () => sendChecked(ctx, ixs))).ok;
        }
        continue;
      }
      if (!p.opened) continue;

      const cp = await corePosition(cpKey);
      if (!cp) {
        log("bridge", subject, "SKIP: bridge Position is opened but tesoro_core Position is missing");
        continue;
      }
      const open = cp.inner.openAdvance;
      const debtFree = open === null || open === undefined;

      // Delivered YieldAccrued newer than the one applied.
      if (p.lastYieldSeq > p.appliedYieldSeq) {
        const openSource = debtFree ? null : coreSourcePda(cpKey, Number(open));
        // Core lands the yield in the Source's book: it comes with the book and its checkpoint pages.
        const books = openSource ? (await supplySources(ctx.core, connReader(ctx.conn), [{ source: openSource, cut: false }])).metas : [];
        const ixs = withCu(400_000, applyYieldIx(p.eid, p.positionId, openSource, books));
        const err = await simulate(ctx.conn, ctx.payer, ixs);
        if (err) {
          waiting++;
          log("bridge", subject, `wait: apply_yield would fail (${err.slice(0, 160)})`);
        } else {
          actions += +(await act(ctx, "bridge", subject, `apply_yield (YieldAccrued seq ${p.lastYieldSeq}, applied ${p.appliedYieldSeq})`, () => sendChecked(ctx, ixs))).ok;
        }
      }

      // Unlocked in tesoro_core with no Debt: tell the vault to release the Principal.
      if (!p.unlockSent && status(cp.inner.status) === "unlocked" && debtFree) {
        actions += await lzSend(ctx, subject, p.eid, p.positionId, 3, "send_unlock", (fee, send) =>
          new TransactionInstruction({
            programId: BRIDGE,
            keys: [
              meta(ctx.payer.publicKey, true, true),
              meta(peerPda(p.eid, p.positionId)),
              meta(STORE),
              meta(p.key, false, true),
              meta(cpKey),
              meta(ENDPOINT_SETTINGS),
              meta(SystemProgram.programId),
              ...send,
            ],
            data: Buffer.concat([disc("send_unlock"), sendParams(p.eid, p.positionId, fee)]),
          }),
        );
      }
    } catch (e) {
      log("bridge", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }

  const byPosition = new Map(positions.map((p) => [corePositionPda(p.eid, p.positionId).toBase58(), p]));
  for (const c of claims) {
    if (c.unitsTotal <= c.unitsSent) continue;
    const p = byPosition.get(c.position.toBase58());
    const subject = `claim=${shortKey(c.address)}`;
    try {
      if (!p || !p.opened) {
        log("bridge", subject, "SKIP: claim's Position is not opened on the bridge");
        continue;
      }
      let evmLink = BRIDGE; // the program id stands for `None`
      if (!c.holderAccount.equals(treasuryAccountPda())) {
        const holder: any = await ctx.core.account.tesoroAccount.fetchNullable(c.holderAccount);
        if (!holder) continue;
        evmLink = evmLinkPda(Uint8Array.from(holder.evmAddress));
      }
      actions += await lzSend(ctx, `${subject} ${label(p.eid, p.positionId)}`, p.eid, p.positionId, 4, `send_pay_yield (${c.unitsTotal - c.unitsSent} units)`, (fee, send) =>
        new TransactionInstruction({
          programId: BRIDGE,
          keys: [
            meta(ctx.payer.publicKey, true, true),
            meta(peerPda(p.eid, p.positionId)),
            meta(STORE),
            meta(p.key, false, true),
            meta(corePositionPda(p.eid, p.positionId)),
            meta(c.holderAccount),
            meta(evmLink),
            meta(c.address, false, true),
            meta(ENDPOINT_SETTINGS),
            meta(SystemProgram.programId),
            ...send,
          ],
          data: Buffer.concat([disc("send_pay_yield"), sendParams(p.eid, p.positionId, fee)]),
        }),
      );
    } catch (e) {
      log("bridge", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }

  for (const c of instantClaims) {
    if (c.unitsTotal <= c.unitsSent) continue;
    const p = byPosition.get(c.position.toBase58());
    const subject = `instant=${shortKey(c.address)}`;
    try {
      if (!p || !p.opened) {
        log("bridge", subject, "SKIP: the Instant Redeem's Position is not opened on the bridge");
        continue;
      }
      const holder: any = await ctx.core.account.tesoroAccount.fetchNullable(c.holderAccount);
      if (!holder) continue;
      const evmLink = evmLinkPda(Uint8Array.from(holder.evmAddress));
      actions += await lzSend(ctx, `${subject} ${label(p.eid, p.positionId)}`, p.eid, p.positionId, 5, `send_pay_instant (${c.unitsTotal - c.unitsSent} units)`, (fee, send) =>
        new TransactionInstruction({
          programId: BRIDGE,
          keys: [
            meta(ctx.payer.publicKey, true, true),
            meta(peerPda(p.eid, p.positionId)),
            meta(STORE),
            meta(p.key, false, true),
            meta(corePositionPda(p.eid, p.positionId)),
            meta(c.holderAccount),
            meta(evmLink),
            meta(c.address, false, true),
            meta(ENDPOINT_SETTINGS),
            meta(SystemProgram.programId),
            ...send,
          ],
          data: Buffer.concat([disc("send_pay_instant"), sendParams(p.eid, p.positionId, fee)]),
        }),
      );
    } catch (e) {
      log("bridge", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }

  log("bridge", "-", `${positions.length} bridge Position(s), ${claims.length} claim(s), ${instantClaims.length} instant claim(s), ${waiting} waiting, ${actions} action(s), LayerZero fees ${(ctx.lz.spentLastHour() / 1e9).toFixed(5)} SOL this hour`);
  return actions;
}

/** Quotes, checks both fee caps, simulates, then sends one outbound LayerZero message. Returns 1 when sent. */
async function lzSend(
  ctx: Ctx,
  subject: string,
  eid: number,
  positionId: Uint8Array,
  msgType: number,
  what: string,
  build: (fee: bigint, send: ReturnType<typeof meta>[]) => TransactionInstruction,
): Promise<number> {
  if (chainByte(eid) === null) return 0;
  const acc = await sendAccounts(ctx, eid, positionId);
  const fee = await quoteFee(ctx, eid, positionId, msgType, acc.quote);
  const feeSol = Number(fee) / 1e9;
  if (Number(fee) > ctx.settings.maxLzFeeLamports) {
    log("bridge", subject, `SKIP ${what}: LayerZero fee ${feeSol} SOL is above the per-message cap ${ctx.settings.maxLzFeeLamports / 1e9} SOL`);
    return 0;
  }
  if (ctx.lz.spentLastHour() + Number(fee) > ctx.settings.lzHourlyCapLamports) {
    log("bridge", subject, `SKIP ${what}: hourly LayerZero fee cap reached (${(ctx.lz.spentLastHour() / 1e9).toFixed(5)} of ${ctx.settings.lzHourlyCapLamports / 1e9} SOL)`);
    return 0;
  }
  const ixs = withCu(600_000, build(fee, acc.send));
  const err = await simulate(ctx.conn, ctx.payer, ixs);
  if (err) {
    log("bridge", subject, `wait: ${what} would fail (${err.slice(0, 160)})`);
    return 0;
  }
  const r = await act(ctx, "bridge", subject, `${what}, LayerZero fee ${feeSol} SOL`, () => sendChecked(ctx, ixs));
  if (r.ok && !ctx.settings.dryRun) ctx.lz.record(Number(fee));
  return +r.ok;
}
