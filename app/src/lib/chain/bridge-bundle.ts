import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import {
  BRIDGE_AUTHORITY,
  BRIDGE_ID,
  bridgePeerPda,
  bridgePositionPda,
  bridgeStore,
  claimPda,
  coreAccountPda,
  corePositionPda,
  deliveryTermsPda,
  evmLinkPda,
  instantClaimPda,
  netOfVault,
  sourceAuthPda,
  vaultTreasuryPda,
} from "./eth";
import { TESORO_CORE_ID, pda, s, sourcePda } from "./native";

/**
 * The bridge steps that ride in an EVM Player's own Tesoro transaction (keeper diet ticket 15), as instructions. The relayer is the
 * LayerZero payer of every send, so a Player with no SOL still finishes. The sponsor's allow-list (server/sponsor/rules.ts) accepts
 * exactly the shapes built here; both sides are tested against each other.
 *
 *   apply_locked                       first Tesoro transaction of a Lock
 *   [apply_yield] unlock send_unlock   Unlock
 *   [apply_yield] redeem_to_evm send_pay_yield
 *   redeem_prize_to_evm send_pay_prize
 *
 * Guards in the bridge (`unlock_sent`, `Claim.units_sent`, the payout state) make a retry of any send safe.
 */

export const MSG_UNLOCK = 10;
export const MSG_PAY_YIELD = 11;
export const MSG_PAY_INSTANT = 12;
export const MSG_PAY_PRIZE = 13;

/** Anchor discriminators of the bridge instructions this module builds (sha256("global:<name>")[..8]). */
export const BUNDLE_DISC = {
  apply_locked: "2f27cfcfbbab2be7",
  apply_yield: "6e7ea020cbc9228f",
  send_unlock: "c572c4f9aa4badcc",
  send_pay_yield: "d0c0a50ea5a3d845",
  send_pay_instant: "114f041c33a0cfa6",
  send_pay_prize: "f7200a59e4d379bb",
  refund_prize_payout: "e16b671dc2ce6ccd",
  redeem_prize_to_evm: "2f9dfa429d66eb73",
  redeem_to_evm: "f8cfc48f001a142e",
} as const;
export type BundleName = keyof typeof BUNDLE_DISC;
const disc = (n: BundleName) => Buffer.from(BUNDLE_DISC[n], "hex");

/** Rent of the bridge accounts a Redeem creates, paid by the signing Player: `Claim` (177 B) and `PayoutRecord` (246 B). */
const RENT_PER_BYTE = 6_960n;
export const CLAIM_RENT = (177n + 128n) * RENT_PER_BYTE;
export const PAYOUT_RECORD_RENT = (246n + 128n) * RENT_PER_BYTE;
/** Rent of the tesoro_core Position `apply_locked` creates, paid by its payer (243 B). */
export const POSITION_RENT = (243n + 128n) * RENT_PER_BYTE;

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u64be = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const k = (pubkey: PublicKey, signer = false, writable = false): AccountMeta => ({ pubkey, isSigner: signer, isWritable: writable });

/** What `/api/eth-bridge` `send-quote` answers: the endpoint's send accounts for one vault and the LayerZero fee in lamports. */
export interface SendQuote {
  endpointSettings: string;
  /** The account in `send` that stands for the fee payer (the relayer when the server quoted); swapped for the real payer. */
  payer: string;
  send: { pubkey: string; signer: boolean; writable: boolean }[];
  feeLamports: string;
}

/** The endpoint's send accounts with `payer` in the payer slot. */
export function sendMetas(q: SendQuote, payer: PublicKey): AccountMeta[] {
  return q.send.map((m) => (m.pubkey === q.payer ? k(payer, m.signer, m.writable) : k(new PublicKey(m.pubkey), m.signer, m.writable)));
}

/** `SendParams` after the eid and Position id: empty options, the native fee, no LayerZero-token fee. */
const sendTail = (fee: bigint) => Buffer.concat([u32le(0), u64le(fee), u64le(0n)]);

export const applyLockedIx = (o: { payer: PublicKey; vault: string; pid: Buffer; ownerEvm: string; ownerAccount: PublicKey }) => {
  const net = netOfVault(o.vault);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(o.payer, true, true),
      k(bridgeStore()),
      k(bridgePeerPda(o.vault)),
      k(bridgePositionPda(o.pid), false, true),
      k(BRIDGE_AUTHORITY),
      k(evmLinkPda(o.ownerEvm)),
      k(o.ownerAccount),
      k(sourceAuthPda(net)),
      k(corePositionPda(o.pid), false, true),
      k(TESORO_CORE_ID),
      k(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("apply_locked"), u32le(net.eid), o.pid]),
  });
};

/** `books`: the open Advance's book and checkpoint pages (writable), as core lands the yield in them. */
export const applyYieldIx = (o: { vault: string; pid: Buffer; openAdvance: number | null; books: PublicKey[] }) => {
  const net = netOfVault(o.vault);
  const cp = corePositionPda(o.pid);
  const source = o.openAdvance === null ? null : sourcePda(cp, o.openAdvance);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(bridgeStore()),
      k(bridgePeerPda(o.vault)),
      k(bridgePositionPda(o.pid), false, true),
      k(vaultTreasuryPda(net.eid, o.vault), false, true),
      k(BRIDGE_AUTHORITY),
      k(sourceAuthPda(net)),
      k(cp, false, true),
      source ? k(source, false, true) : k(BRIDGE_ID),
      k(TESORO_CORE_ID),
      ...o.books.map((b) => k(b, false, true)),
    ],
    data: Buffer.concat([disc("apply_yield"), u32le(net.eid), o.pid]),
  });
};

const sendParams = (vault: string, pid: Buffer, fee: bigint) => Buffer.concat([u32le(netOfVault(vault).eid), pid, sendTail(fee)]);

export const sendUnlockIx = (o: { payer: PublicKey; vault: string; pid: Buffer; quote: SendQuote }) => {
  const fee = BigInt(o.quote.feeLamports);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(o.payer, true, true),
      k(bridgePeerPda(o.vault)),
      k(bridgeStore()),
      k(bridgePositionPda(o.pid), false, true),
      k(corePositionPda(o.pid)),
      k(deliveryTermsPda(o.vault)),
      k(new PublicKey(o.quote.endpointSettings)),
      k(SystemProgram.programId),
      ...sendMetas(o.quote, o.payer),
    ],
    data: Buffer.concat([disc("send_unlock"), sendParams(o.vault, o.pid, fee)]),
  });
};

/** `send_pay_yield` (kind "yield") or `send_pay_instant` (kind "instant") of the holder's Claim on one Source. */
export const sendPayIx = (o: { kind: "yield" | "instant"; payer: PublicKey; vault: string; pid: Buffer; holder: PublicKey; holderEvm: string; sourceIndex: number; quote: SendQuote }) => {
  const cp = corePositionPda(o.pid);
  const holderAccount = coreAccountPda(o.holder);
  const source = sourcePda(cp, o.sourceIndex);
  const claim = o.kind === "yield" ? claimPda(holderAccount, source) : instantClaimPda(holderAccount, source);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(o.payer, true, true),
      k(bridgePeerPda(o.vault)),
      k(bridgeStore()),
      k(bridgePositionPda(o.pid), false, true),
      k(cp),
      k(holderAccount),
      k(evmLinkPda(o.holderEvm)),
      k(claim, false, true),
      k(new PublicKey(o.quote.endpointSettings)),
      k(SystemProgram.programId),
      ...sendMetas(o.quote, o.payer),
    ],
    data: Buffer.concat([disc(o.kind === "yield" ? "send_pay_yield" : "send_pay_instant"), sendParams(o.vault, o.pid, BigInt(o.quote.feeLamports))]),
  });
};

// ---- Prize payouts (a Season prize cashed out to the EVM wallet) -----------------------------------------------

export const routePda = (eid: number, peer: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("route"), u32be(eid), peer], BRIDGE_ID)[0];
export const payoutPda = (eid: number, peer: Buffer, id: bigint) => PublicKey.findProgramAddressSync([Buffer.from("payout"), u32be(eid), peer, u64be(id)], BRIDGE_ID)[0];
const vaultWord = (vault: string) => Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex");

export const sendPayPrizeIx = (o: { payer: PublicKey; vault: string; payoutId: bigint; quote: SendQuote }) => {
  const net = netOfVault(o.vault);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(o.payer, true, true),
      k(bridgeStore()),
      k(bridgePeerPda(o.vault)),
      k(payoutPda(net.eid, vaultWord(o.vault), o.payoutId), false, true),
      k(SystemProgram.programId),
      ...sendMetas(o.quote, o.payer),
    ],
    data: Buffer.concat([disc("send_pay_prize"), u32le(net.eid), vaultWord(o.vault), u64le(o.payoutId), sendTail(BigInt(o.quote.feeLamports))]),
  });
};

/** The vault rejected a prize payout for good: the holder gets the Gemas back and the prize Source its shares. Permissionless, no fee. */
export const refundPrizePayoutIx = (o: { vault: string; payoutId: bigint; holder: PublicKey; prizeSource: PublicKey; holderBasket: PublicKey; holderSpill: PublicKey }) => {
  const net = netOfVault(o.vault);
  const peer = vaultWord(o.vault);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      k(bridgeStore()),
      k(BRIDGE_AUTHORITY),
      k(routePda(net.eid, peer), false, true),
      k(payoutPda(net.eid, peer, o.payoutId), false, true),
      k(sourceAuthPda(net)),
      k(coreAccountPda(o.holder)),
      k(o.holderBasket, false, true),
      k(o.holderSpill, false, true),
      k(o.prizeSource, false, true),
      k(TESORO_CORE_ID),
    ],
    data: disc("refund_prize_payout"),
  });
};

/** Names a bridge instruction by its discriminator; null for any other. */
export function bundleNameOf(data: Uint8Array): BundleName | null {
  const head = Buffer.from(data.subarray(0, 8)).toString("hex");
  return (Object.keys(BUNDLE_DISC) as BundleName[]).find((n) => BUNDLE_DISC[n] === head) ?? null;
}

/** Where the Player's SOL must come from: a system transfer of exactly `lamports` from the relayer to the Player (the rent of the Claim or Payout the Redeem creates). */
export const rentTransferIx = (relayer: PublicKey, player: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: relayer, toPubkey: player, lamports });

/**
 * The addresses of one vault's bridge steps that depend on neither the Player nor the Position: they go in the bridge's address
 * lookup table (`app/scripts/bridge-lookup-table.mjs`). The Player's own accounts, the Position's and the program ids stay in the
 * message. The relayer (the fee payer, a signer) is never in a table.
 */
export function stableBridgeAddresses(vault: string, quote: Pick<SendQuote, "endpointSettings" | "payer" | "send">): PublicKey[] {
  const net = netOfVault(vault);
  const own = [
    bridgeStore(),
    BRIDGE_AUTHORITY,
    SystemProgram.programId,
    bridgePeerPda(vault),
    deliveryTermsPda(vault),
    vaultTreasuryPda(net.eid, vault),
    sourceAuthPda(net),
    pda([s("economy")]),
    new PublicKey(quote.endpointSettings),
  ];
  const send = quote.send.filter((m) => m.pubkey !== quote.payer).map((m) => new PublicKey(m.pubkey));
  return [...new Map([...own, ...send].map((a) => [a.toBase58(), a])).values()];
}
