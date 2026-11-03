/**
 * What the relayer checks before it pays a LayerZero fee inside a Player's transaction (keeper diet ticket 15). The allow-list
 * (./rules-bridge.ts) already fixed the shape and every PDA; this is the part that needs the chain and the day's counters:
 *
 *   1. the vault's Delivery Terms carry a nonzero fee, so the send is paid back on the EVM side (ticket 14, review item 7);
 *   2. the fee in the instruction is at most a fresh LayerZero quote plus headroom (the endpoint charges what it is given);
 *   3. the endpoint's send accounts are exactly the ones the server computes for that vault;
 *   4. a prize payout belongs to the Player who asks;
 *   5. the Account has sends left today.
 *
 * A refusal here is never final: the Player may send the same instructions and pay the LayerZero fee from their own SOL.
 */
import { PublicKey } from "@solana/web3.js";
import { DemoHttpError } from "../request-auth";
import { BRIDGE_ID, coreAccountPda, deliveryTermsPda } from "@/lib/chain/eth";
import { parseDeliveryTerms } from "@/lib/chain/delivery-fee";
import type { BridgeSend, Plan } from "./rules";
import type { Limits } from "./policy";
import type { UsageStore } from "./store";

const DAY = 24 * 60 * 60 * 1000;
/** A quote moves a little between the Player's page and the send: this much above it is fine. */
const FEE_HEADROOM_NUM = 5n;
const FEE_HEADROOM_DEN = 4n;
const FEE_SLACK_LAMPORTS = 5_000n;
/** `PayoutRecord.holder_account` sits after the 8-byte discriminator, eid, peer, id, bump, rent payer and state. */
const PAYOUT_HOLDER_AT = 8 + 4 + 32 + 8 + 1 + 32 + 1;

export interface SendAccount {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

export interface BridgeSendGuard {
  /** The native fee (lamports) LayerZero quotes now for a message type to a vault. */
  quote(vault: string, msgType: number): Promise<bigint>;
  /** The endpoint's send accounts for the vault, with the relayer in the payer slot. */
  sendAccounts(vault: string): Promise<SendAccount[]>;
}

interface Reads {
  account(key: PublicKey): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
}

const refuse = (status: number, code: string, message: string) => new DemoHttpError(status, code, message);

async function requireDeliveryFee(send: BridgeSend, chain: Reads) {
  const info = await chain.account(deliveryTermsPda(send.vault));
  const terms = info && info.owner.equals(BRIDGE_ID) ? parseDeliveryTerms(info.data) : null;
  const cap = send.kind === "yield" ? terms?.maxBpsYield : terms?.maxBpsUnlock;
  const carries = !!terms && terms.deliveryFee > 0n && terms.maxAbs > 0n && (send.kind === "prize" || (cap ?? 0) > 0);
  if (!carries) throw refuse(409, "no-delivery-fee", "This transfer carries no Delivery Fee, so it is not free. Pay the network fee from your own SOL to finish.");
}

async function requireHonestSend(send: BridgeSend, guard: BridgeSendGuard) {
  const quote = await guard.quote(send.vault, send.msgType);
  if (send.feeLamports > quote + (quote * (FEE_HEADROOM_NUM - FEE_HEADROOM_DEN)) / FEE_HEADROOM_DEN + FEE_SLACK_LAMPORTS) throw refuse(409, "fee-changed", "The cross-chain fee changed. Try again.");
  const want = await guard.sendAccounts(send.vault);
  const same = want.length === send.send.length && want.every((w, i) => w.pubkey === send.send[i].pubkey.toBase58() && w.signer === send.send[i].isSigner && w.writable === send.send[i].isWritable);
  if (!same) throw refuse(400, "bad-accounts", "The cross-chain accounts are not the ones for this contract. Try again.");
}

async function requireOwnPayout(send: BridgeSend, player: PublicKey, chain: Reads) {
  const payout = send.payout ? await chain.account(send.payout) : null;
  if (!payout || !payout.owner.equals(BRIDGE_ID) || payout.data.length < PAYOUT_HOLDER_AT + 32 || !new PublicKey(payout.data.subarray(PAYOUT_HOLDER_AT, PAYOUT_HOLDER_AT + 32)).equals(coreAccountPda(player))) {
    throw refuse(403, "not-your-payout", "That payout is not yours.");
  }
}

/** Checks every send of `plan` and takes the day's count. Returns what gives the count back when the build fails later. */
export async function admitSends(o: { plan: Plan; player: PublicKey; now: number; store: UsageStore; limits: Limits; chain: Reads; guard?: BridgeSendGuard }): Promise<() => Promise<void>> {
  const sends = o.plan.sends ?? [];
  if (!o.guard) throw refuse(503, "not-configured", "Free cross-chain transfers are not set up on this server. Pay the network fee from your own SOL to finish.");
  for (const send of sends) {
    await requireDeliveryFee(send, o.chain);
    await requireHonestSend(send, o.guard);
    if (send.kind === "prize") await requireOwnPayout(send, o.player, o.chain);
  }
  const key = `bridgesend:${o.player.toBase58()}`;
  if (!(await o.store.take(key, sends.length, o.limits.bridgeSendsPerDay, DAY, o.now))) {
    throw refuse(429, "bridge-send-limit", "Free cross-chain transfers are used up for today. Pay the network fee from your own SOL to finish.");
  }
  return () => o.store.refund(key, sends.length, o.now);
}

/** Takes the day's count of checkpoint pages the relayer creates for this Account's bundles; returns what gives it back. */
export async function admitPages(o: { plan: Plan; player: PublicKey; now: number; store: UsageStore; limits: Limits }): Promise<() => Promise<void>> {
  const n = o.plan.pages?.length ?? 0;
  const key = `ckptpage:${o.player.toBase58()}`;
  if (!(await o.store.take(key, n, o.limits.checkpointPagesPerDay, DAY, o.now))) {
    throw refuse(429, "bridge-send-limit", "Free checkpoint pages are used up for today. Pay the network fee from your own SOL to finish.");
  }
  return () => o.store.refund(key, n, o.now);
}
