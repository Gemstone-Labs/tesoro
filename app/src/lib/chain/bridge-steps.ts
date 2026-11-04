import "./polyfill";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import {
  applyLockedIx,
  applyYieldIx,
  sendPayIx,
  sendUnlockIx,
  type SendQuote,
} from "./bridge-bundle";
import { coreUnlockIx, ethPositionId, evmLinkPda, redeemToEvmIx, corePositionPda, type EthState } from "./eth";
import { sourcePda } from "./native";
import type { LineRef } from "./basket";
import { isInitCkptPage, sourceAccounts } from "./redeem";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

/**
 * The bridge steps of an EVM Player's flows, built for one sponsored transaction (keeper diet ticket 15):
 *
 *   Lock      apply_locked                                 (before the Advance; the Position is created here)
 *   Unlock    [apply_yield] unlock send_unlock
 *   Redeem    [apply_yield] redeem_to_evm send_pay_yield   (the relayer is the Claim's payer; the holder only signs)
 *
 * `build(payer, sponsored)` returns groups of instructions. Sponsored, the relayer is `payer`, there is one group and the sponsor
 * accepts it (server/sponsor/rules-bridge.ts), with the relayer also creating any checkpoint page the Source's book needs. When it cannot or will not (paused, over a limit, no Delivery Fee, a checkpoint
 * page to create), the Player pays: each group goes alone, because the whole bundle fits one packet only with the bridge's lookup
 * table, which the sponsor adds and the Player's own transaction does not have.
 */

export type Groups = TransactionInstruction[][];
export type Build = (payer: PublicKey, sponsored: boolean) => Promise<Groups>;

export interface ApplyYieldPlan {
  openAdvance: number | null;
  /** The open Advance's book and checkpoint pages. */
  books: PublicKey[];
  /** `init_ckpt_page` for pages a landing may need and nobody created: the payer pays their rent. */
  create: TransactionInstruction[];
}

/** Whether a Yield Report arrived on Solana that is not applied yet. */
export const yieldDue = (s: Pick<EthState, "bridge"> | null) => !!s?.bridge && s.bridge.lastYieldSeq > 0n && s.bridge.lastYieldSeq > s.bridge.appliedYieldSeq;

type Reader = Parameters<typeof sourceAccounts>[0];

/** The books `apply_yield` passes: the open Advance's Source book and its landing pages (none without an open Advance). */
export async function planApplyYield(conn: Reader, vault: string, id: bigint, openAdvance: number | null, payer: PublicKey): Promise<ApplyYieldPlan> {
  if (openAdvance === null) return { openAdvance, books: [], create: [] };
  const source = sourcePda(corePositionPda(ethPositionId(vault, id)), openAdvance);
  const plan = await sourceAccounts(conn, source, [], payer);
  return { openAdvance, books: plan.accounts, create: plan.create };
}

const yieldGroup = (ref: { vault: string; id: bigint }, y: ApplyYieldPlan) => applyYieldIx({ vault: ref.vault, pid: ethPositionId(ref.vault, ref.id), openAdvance: y.openAdvance, books: y.books });

export interface UnlockInput {
  payer: PublicKey;
  sponsored: boolean;
  player: PublicKey;
  vault: string;
  id: bigint;
  position: PublicKey;
  /** The Position's open Advance with its book and pages (and the pages to create), or null when it has none. */
  open: { index: number; accounts: PublicKey[]; create: TransactionInstruction[] } | null;
  /** Set when a Yield Report is waiting to be applied. */
  applyYield: ApplyYieldPlan | null;
  quote: SendQuote;
}

/** `[apply_yield] unlock send_unlock`, or two groups when the Player pays. */
export function unlockGroups(o: UnlockInput): Groups {
  const ref = { vault: o.vault, id: o.id };
  const unlock = coreUnlockIx(o.player, o.position, o.open ? { index: o.open.index, accounts: o.open.accounts } : null);
  const send = sendUnlockIx({ payer: o.payer, vault: o.vault, pid: ethPositionId(o.vault, o.id), quote: o.quote });
  const create = [...(o.applyYield?.create ?? []), ...(o.open?.create ?? [])];
  const apply = o.applyYield ? [yieldGroup(ref, o.applyYield)] : [];
  if (!o.sponsored) return [[...create, ...apply, unlock], [send]];
  return [[...create, ...apply, unlock, send]];
}

export interface RedeemInput {
  payer: PublicKey;
  sponsored: boolean;
  player: PublicKey;
  vault: string;
  id: bigint;
  position: PublicKey;
  source: PublicKey;
  sourceIndex: number;
  gemas: bigint;
  target: { line: LineRef; accounts: PublicKey[] };
  /** Pages to create before the Redeem (the Source's landing pages nobody created). */
  create: TransactionInstruction[];
  holderEvm: string;
  applyYield: ApplyYieldPlan | null;
  quote: SendQuote;
}

/** `[apply_yield] redeem_to_evm send_pay_yield`: `payer` (the relayer, or the Player when they pay) funds the Claim's rent. */
export function redeemGroups(o: RedeemInput): Groups {
  const ref = { vault: o.vault, id: o.id };
  const redeem = redeemToEvmIx(o.player, o.position, o.source, o.gemas, o.vault, o.target, o.payer);
  const send = sendPayIx({ kind: "yield", payer: o.payer, vault: o.vault, pid: ethPositionId(o.vault, o.id), holder: o.player, holderEvm: o.holderEvm, sourceIndex: o.sourceIndex, quote: o.quote });
  const create = [...(o.applyYield?.create ?? []), ...o.create];
  const apply = o.applyYield ? [yieldGroup(ref, o.applyYield)] : [];
  if (!o.sponsored) return [[...create, ...apply, redeem], [send]];
  return [[...create, ...apply, redeem, send]];
}

/** `apply_yield` alone: lands a Yield Report that arrived. Nobody signs it. */
export function applyYieldGroups(o: { sponsored: boolean; vault: string; id: bigint; plan: ApplyYieldPlan }): Groups {
  return [[...o.plan.create, yieldGroup(o, o.plan)]];
}

/** The send alone, for a transfer whose Unlock or Redeem is recorded on Solana and whose message has not gone out. */
export function sendGroups(o: { payer: PublicKey; vault: string; id: bigint } & ({ kind: "unlock"; quote: SendQuote } | { kind: "yield" | "instant"; player: PublicKey; holderEvm: string; sourceIndex: number; quote: SendQuote })): Groups {
  const pid = ethPositionId(o.vault, o.id);
  if (o.kind === "unlock") return [[sendUnlockIx({ payer: o.payer, vault: o.vault, pid, quote: o.quote })]];
  return [[sendPayIx({ kind: o.kind, payer: o.payer, vault: o.vault, pid, holder: o.player, holderEvm: o.holderEvm, sourceIndex: o.sourceIndex, quote: o.quote })]];
}

/** `apply_locked`: the delivered Lock becomes a Position on Solana. The payer funds its rent (the relayer's, sunk). */
export function openingGroups(o: { payer: PublicKey; vault: string; id: bigint; ownerEvm: string; ownerAccount: PublicKey }): Groups {
  return [[applyLockedIx({ payer: o.payer, vault: o.vault, pid: ethPositionId(o.vault, o.id), ownerEvm: o.ownerEvm, ownerAccount: o.ownerAccount })]];
}

/** The Account an EVM address is linked to, from its `EvmLink`; null when it is not linked. */
export async function linkedAccount(conn: { getAccountInfo(k: PublicKey): Promise<{ data: Uint8Array } | null> }, evm: string): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(evmLinkPda(evm));
  return info && info.data.length >= 8 + 20 + 32 ? new PublicKey(info.data.subarray(8 + 20, 8 + 52)) : null;
}

/**
 * Sends `build`'s groups: as one transaction the relayer pays when the sponsor accepts, else each group alone from the Player's own SOL
 * (topped up on the test cluster). A refusal that is not a "pay it yourself" one is thrown. Returns the signature of the last transaction,
 * the one that carries the send.
 */
export async function sendBridgeGroups(signer: ChainSigner, getToken: GetToken, build: Build): Promise<string> {
  if (signer.signSerialized) {
    try {
      const { relayer, paused } = await sponsorStatus();
      if (!paused) {
        const ixs = (await build(new PublicKey(relayer), true)).flat();
        try {
          return await sponsoredSend(signer, getToken, ixs);
        } catch (e) {
          // Checkpoint pages in front can push the message over one packet: the relayer creates them first, then the rest.
          const pages = ixs.filter(isInitCkptPage);
          if (!(e instanceof SponsorError) || e.code !== "too-large" || pages.length === 0 || pages.length === ixs.length) throw e;
          await sponsoredSend(signer, getToken, pages);
          return await sponsoredSend(signer, getToken, ixs.filter((ix) => !isInitCkptPage(ix)));
        }
      }
    } catch (e) {
      if (!(e instanceof SponsorError) || !(e.selfPay || e.code === "unsupported-wallet")) throw e;
    }
  }
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  const groups = await build(signer.publicKey, false);
  let last = "";
  for (const group of groups) last = await getChain().sendBase(signer, group);
  return last;
}
