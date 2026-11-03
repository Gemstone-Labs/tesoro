/**
 * The relayer's allow-list for the bridge steps that ride in an EVM Player's own transaction (keeper diet ticket 15). Pure like
 * ./rules.ts, which calls it. The shapes are the ones `src/lib/chain/bridge-bundle.ts` builds:
 *
 *   apply_locked | apply_yield | send_unlock | send_pay_yield | send_pay_instant | send_pay_prize | refund_prize_payout
 *   [apply_yield] unlock send_unlock
 *   [rent transfer] [apply_yield] redeem_to_evm send_pay_yield
 *   [rent transfer] redeem_prize_to_evm send_pay_prize
 *
 * Money rules: the relayer is only ever the LayerZero payer (first account of a send, or of apply_locked) or the sender of one
 * exact rent transfer to the Player. A send's options are empty and its LayerZero-token fee is 0; its native fee is bounded here
 * and again by the service against a fresh quote. Every PDA is derived from the Position id in the instruction data, and the
 * Position's vault must be one the app lists.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { CLAIM_RENT, PAYOUT_RECORD_RENT, bundleNameOf, payoutPda, type BundleName } from "@/lib/chain/bridge-bundle";
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
  ETH_VAULTS,
  vaultByAddress,
  netOfVault,
  sourceAuthPda,
  vaultTreasuryPda,
} from "@/lib/chain/eth";
import { basketPda, spillPda } from "@/lib/chain/basket";
import { TESORO_CORE_ID } from "@/lib/chain/native";
import { RuleError, planCore, type BridgeSend, type Ix, type KeyMeta, type Plan } from "./rules";

/** The most one LayerZero message may cost the relayer (the keeper's per-message cap). The service also checks a fresh quote. */
export const MAX_LZ_FEE_LAMPORTS = 5_000_000n;
/** The endpoint's send account list has 26 entries today; a different count is not what the app built. */
const SEND_ACCOUNTS_MIN = 10;
const SEND_ACCOUNTS_MAX = 40;
/** Books and checkpoint pages `apply_yield` and the redeems may carry beyond their own accounts. */
const MAX_EXTRA = 60;

const ROW_CU: Record<BundleName, number> = {
  apply_locked: 150_000,
  apply_yield: 300_000,
  redeem_to_evm: 400_000,
  redeem_prize_to_evm: 300_000,
  send_unlock: 400_000,
  send_pay_yield: 400_000,
  send_pay_instant: 400_000,
  send_pay_prize: 400_000,
  refund_prize_payout: 200_000,
};

/** Shapes, by instruction name; `unlock` is a tesoro_core instruction, `transfer` the rent transfer. */
const SHAPES: readonly (readonly string[])[] = [
  ["apply_locked"],
  ["apply_yield"],
  ["send_unlock"],
  ["send_pay_yield"],
  ["send_pay_instant"],
  ["send_pay_prize"],
  ["refund_prize_payout"],
  ["redeem_to_evm"],
  ["unlock", "send_unlock"],
  ["apply_yield", "unlock", "send_unlock"],
  ["redeem_to_evm", "send_pay_yield"],
  ["apply_yield", "redeem_to_evm", "send_pay_yield"],
  ["transfer", "redeem_to_evm"],
  ["transfer", "redeem_to_evm", "send_pay_yield"],
  ["transfer", "apply_yield", "redeem_to_evm", "send_pay_yield"],
  ["redeem_prize_to_evm"],
  ["transfer", "redeem_prize_to_evm"],
  ["redeem_prize_to_evm", "send_pay_prize"],
  ["transfer", "redeem_prize_to_evm", "send_pay_prize"],
];

const bad = (code: string, message: string): never => {
  throw new RuleError(code, message);
};
const same = (a: PublicKey, b: PublicKey) => a.equals(b);
const rdU32 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt32LE(o);
const rdU64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** One account slot: signer and writable flags exact, and optionally the exact address. */
function slot(ix: Ix, name: string, i: number, signer: boolean, writable: boolean, want?: PublicKey) {
  const k = ix.keys[i];
  if (!k) return bad("bad-accounts", `${name}: account ${i} is missing.`);
  if (k.isSigner !== signer || k.isWritable !== writable) bad("bad-flags", `${name}: account ${i} has the wrong signer or writable flag.`);
  if (want && !same(k.pubkey, want)) bad("bad-account", `${name}: account ${i} is not the expected address.`);
  return k.pubkey;
}

/** The relayer may stand only at `payerAt` of an instruction that names a payer. */
function relayerOnlyAt(ix: Ix, name: string, relayer: PublicKey, payerAt: number | null, upTo = ix.keys.length) {
  ix.keys.slice(0, upTo).forEach((k, i) => {
    if (k.pubkey.equals(relayer) && i !== payerAt) bad("relayer-in-accounts", `${name}: the relayer may only pay the fee.`);
  });
}

/** `[eid u32 LE][position id 32]` after the discriminator: the vault and id every PDA of the instruction derives from. */
function positionOf(ix: Ix, name: string, dataLength: number) {
  if (ix.data.length !== dataLength) bad("bad-data", `${name}: the instruction data is the wrong size.`);
  const pid = Buffer.from(ix.data.subarray(12, 44));
  const vault = vaultByAddress(`0x${hex(pid.subarray(0, 20))}`)?.address ?? bad("bad-vault", `${name}: that is not a Lock on a contract we support.`);
  if (rdU32(ix.data, 8) !== netOfVault(vault).eid) bad("bad-data", `${name}: the endpoint id does not match the vault.`);
  return { pid, vault, net: netOfVault(vault) };
}

interface Checked {
  name: string;
  vault: string;
  pid: Buffer | null;
  send?: BridgeSend;
  /** The holder-side keys a later instruction of the bundle must agree with. */
  claim?: PublicKey;
  holderAccount?: PublicKey;
  corePosition?: PublicKey;
  signers: PublicKey[];
}

/** Sends end `[endpoint settings, system, ...send accounts]`: the relayer pays at the first send account and signs nowhere else. */
function checkSend(ix: Ix, name: string, relayer: PublicKey, fixedCount: number, feeAt: number) {
  const fee = rdU64(ix.data, feeAt);
  if (rdU32(ix.data, feeAt - 4) !== 0) bad("bad-data", `${name}: options must be empty.`);
  if (rdU64(ix.data, feeAt + 8) !== 0n) bad("bad-data", `${name}: no LayerZero-token fee.`);
  if (fee === 0n || fee > MAX_LZ_FEE_LAMPORTS) bad("fee-too-high", `${name}: the LayerZero fee is outside what we pay.`);
  const send: KeyMeta[] = ix.keys.slice(fixedCount);
  if (send.length < SEND_ACCOUNTS_MIN || send.length > SEND_ACCOUNTS_MAX) bad("bad-accounts", `${name}: the endpoint's send accounts are the wrong count.`);
  send.forEach((k, i) => {
    if (k.isSigner && !k.pubkey.equals(relayer)) bad("bad-accounts", `${name}: only the payer signs in the endpoint's accounts.`);
    // The relayer is the endpoint's payer: the first send account, signing and writable, and nowhere else.
    if (k.pubkey.equals(relayer) && (i !== 0 || !k.isSigner || !k.isWritable)) bad("relayer-in-accounts", `${name}: the relayer may only be the endpoint's payer.`);
  });
  return { fee, send };
}

function checkApplyLocked(ix: Ix, relayer: PublicKey): Checked {
  const name = "apply_locked";
  const { pid, vault, net } = positionOf(ix, name, 8 + 4 + 32);
  if (ix.keys.length !== 11) bad("bad-accounts", `${name} has the wrong number of accounts.`);
  slot(ix, name, 0, true, true, relayer);
  slot(ix, name, 1, false, false, bridgeStore());
  slot(ix, name, 2, false, false, bridgePeerPda(vault));
  slot(ix, name, 3, false, true, bridgePositionPda(pid));
  slot(ix, name, 4, false, false, BRIDGE_AUTHORITY);
  slot(ix, name, 5, false, false);
  slot(ix, name, 6, false, false);
  slot(ix, name, 7, false, false, sourceAuthPda(net));
  slot(ix, name, 8, false, true, corePositionPda(pid));
  slot(ix, name, 9, false, false, TESORO_CORE_ID);
  slot(ix, name, 10, false, false, SystemProgram.programId);
  relayerOnlyAt(ix, name, relayer, 0);
  return { name, vault, pid, signers: [], corePosition: corePositionPda(pid) };
}

function checkApplyYield(ix: Ix, relayer: PublicKey): Checked {
  const name = "apply_yield";
  const { pid, vault, net } = positionOf(ix, name, 8 + 4 + 32);
  if (ix.keys.length < 9 || ix.keys.length > 9 + MAX_EXTRA) bad("bad-accounts", `${name} has the wrong number of accounts.`);
  slot(ix, name, 0, false, false, bridgeStore());
  slot(ix, name, 1, false, false, bridgePeerPda(vault));
  slot(ix, name, 2, false, true, bridgePositionPda(pid));
  slot(ix, name, 3, false, true, vaultTreasuryPda(net.eid, vault));
  slot(ix, name, 4, false, false, BRIDGE_AUTHORITY);
  slot(ix, name, 5, false, false, sourceAuthPda(net));
  slot(ix, name, 6, false, true, corePositionPda(pid));
  const source = ix.keys[7];
  if (!source) bad("bad-accounts", `${name}: the open Source is missing.`);
  if (source.isSigner || (source.pubkey.equals(BRIDGE_ID) ? source.isWritable : !source.isWritable)) bad("bad-flags", `${name}: the open Source has the wrong flags.`);
  slot(ix, name, 8, false, false, TESORO_CORE_ID);
  ix.keys.slice(9).forEach((k, i) => {
    if (k.isSigner || !k.isWritable) bad("bad-accounts", `${name}: account ${9 + i} must be a writable book or page.`);
  });
  relayerOnlyAt(ix, name, relayer, null);
  return { name, vault, pid, signers: [], corePosition: corePositionPda(pid) };
}

function checkSendUnlock(ix: Ix, relayer: PublicKey): Checked {
  const name = "send_unlock";
  const { pid, vault } = positionOf(ix, name, 8 + 4 + 32 + 4 + 8 + 8);
  slot(ix, name, 0, true, true, relayer);
  slot(ix, name, 1, false, false, bridgePeerPda(vault));
  slot(ix, name, 2, false, false, bridgeStore());
  slot(ix, name, 3, false, true, bridgePositionPda(pid));
  slot(ix, name, 4, false, false, corePositionPda(pid));
  slot(ix, name, 5, false, false, deliveryTermsPda(vault));
  slot(ix, name, 6, false, false);
  slot(ix, name, 7, false, false, SystemProgram.programId);
  const { fee, send } = checkSend(ix, name, relayer, 8, 8 + 4 + 32 + 4);
  relayerOnlyAt(ix, name, relayer, 0, 8);
  return { name, vault, pid, signers: [], corePosition: corePositionPda(pid), send: { kind: "unlock", vault, msgType: 10, feeLamports: fee, send } };
}

function checkSendPay(kind: "yield" | "instant", ix: Ix, relayer: PublicKey, player: PublicKey): Checked {
  const name = kind === "yield" ? "send_pay_yield" : "send_pay_instant";
  const { pid, vault } = positionOf(ix, name, 8 + 4 + 32 + 4 + 8 + 8);
  const holder = coreAccountPda(player);
  slot(ix, name, 0, true, true, relayer);
  slot(ix, name, 1, false, false, bridgePeerPda(vault));
  slot(ix, name, 2, false, false, bridgeStore());
  slot(ix, name, 3, false, true, bridgePositionPda(pid));
  slot(ix, name, 4, false, false, corePositionPda(pid));
  slot(ix, name, 5, false, false, holder);
  slot(ix, name, 6, false, false);
  const claim = slot(ix, name, 7, false, true);
  slot(ix, name, 8, false, false);
  slot(ix, name, 9, false, false, SystemProgram.programId);
  const { fee, send } = checkSend(ix, name, relayer, 10, 8 + 4 + 32 + 4);
  relayerOnlyAt(ix, name, relayer, 0, 10);
  return { name, vault, pid, signers: [], claim, holderAccount: holder, corePosition: corePositionPda(pid), send: { kind, vault, msgType: kind === "yield" ? 11 : 12, feeLamports: fee, send, holderAccount: holder, claim } };
}

/** `[eid u32][peer 32][payout id u64][options len 0][fee][lz fee]`: the Position id of the others is the peer word here. */
function checkSendPayPrize(ix: Ix, relayer: PublicKey): Checked {
  const name = "send_pay_prize";
  if (ix.data.length !== 8 + 4 + 32 + 8 + 4 + 8 + 8) bad("bad-data", `${name}: the instruction data is the wrong size.`);
  const peer = Buffer.from(ix.data.subarray(12, 44));
  const listed = vaultByAddress(`0x${hex(peer.subarray(12, 32))}`);
  if (peer.subarray(0, 12).some((b) => b !== 0) || !listed) bad("bad-vault", `${name}: that is not a contract we support.`);
  const vault = listed!.address as string;
  if (rdU32(ix.data, 8) !== netOfVault(vault).eid) bad("bad-data", `${name}: the endpoint id does not match the vault.`);
  const payoutId = rdU64(ix.data, 44);
  slot(ix, name, 0, true, true, relayer);
  slot(ix, name, 1, false, false, bridgeStore());
  slot(ix, name, 2, false, false, bridgePeerPda(vault));
  const payout = slot(ix, name, 3, false, true, payoutPda(netOfVault(vault).eid, peer, payoutId));
  slot(ix, name, 4, false, false, SystemProgram.programId);
  const { fee, send } = checkSend(ix, name, relayer, 5, 8 + 4 + 32 + 8 + 4);
  relayerOnlyAt(ix, name, relayer, 0, 5);
  return { name, vault, pid: null, signers: [], send: { kind: "prize", vault, msgType: 13, feeLamports: fee, send, payout, payoutId } };
}

function checkRefundPrize(ix: Ix, relayer: PublicKey, player: PublicKey): Checked {
  const name = "refund_prize_payout";
  if (ix.data.length !== 8) bad("bad-data", `${name}: the instruction data is the wrong size.`);
  if (ix.keys.length !== 10) bad("bad-accounts", `${name} has the wrong number of accounts.`);
  slot(ix, name, 0, false, false, bridgeStore());
  slot(ix, name, 1, false, false, BRIDGE_AUTHORITY);
  slot(ix, name, 2, false, true);
  slot(ix, name, 3, false, true);
  slot(ix, name, 4, false, false);
  slot(ix, name, 5, false, false, coreAccountPda(player));
  slot(ix, name, 6, false, true, basketPda(coreAccountPda(player)));
  slot(ix, name, 7, false, true, spillPda(coreAccountPda(player)));
  slot(ix, name, 8, false, true);
  slot(ix, name, 9, false, false, TESORO_CORE_ID);
  relayerOnlyAt(ix, name, relayer, null);
  return { name, vault: "", pid: null, signers: [], holderAccount: coreAccountPda(player) };
}

/** The Player's `redeem_to_evm`: a Redeem of Gemas of an EVM Source, recording the payout the next send delivers. */
function checkRedeemToEvm(ix: Ix, relayer: PublicKey, player: PublicKey): Checked {
  const name = "redeem_to_evm";
  if (ix.data.length !== 8 + 11 + 8) bad("bad-data", `${name}: the instruction data is the wrong size.`);
  if (ix.keys.length < 14 || ix.keys.length > 14 + MAX_EXTRA) bad("bad-accounts", `${name} has the wrong number of accounts.`);
  const terms = ix.keys[10]?.pubkey;
  const vault = (terms && vaultOfTerms(terms)) ?? bad("bad-vault", `${name}: that is not a Lock on a contract we support.`);
  const net = netOfVault(vault);
  const holder = coreAccountPda(player);
  slot(ix, name, 0, true, true, player);
  slot(ix, name, 1, false, false, bridgeStore());
  slot(ix, name, 2, false, false, BRIDGE_AUTHORITY);
  slot(ix, name, 3, false, false, sourceAuthPda(net));
  slot(ix, name, 4, false, true, holder);
  const position = slot(ix, name, 5, false, true);
  const source = slot(ix, name, 6, false, true);
  slot(ix, name, 7, false, true, basketPda(holder));
  slot(ix, name, 8, false, true, spillPda(holder));
  const claim = slot(ix, name, 9, false, true, claimPda(holder, source));
  slot(ix, name, 10, false, false, deliveryTermsPda(vault));
  slot(ix, name, 11, false, false, bridgePeerPda(vault));
  slot(ix, name, 12, false, false, TESORO_CORE_ID);
  slot(ix, name, 13, false, false, SystemProgram.programId);
  ix.keys.slice(14).forEach((k, i) => {
    if (k.isSigner) bad("bad-accounts", `${name}: account ${14 + i} may not sign.`);
  });
  relayerOnlyAt(ix, name, relayer, null);
  return { name, vault, pid: null, claim, holderAccount: holder, corePosition: position, signers: [player] };
}

function checkRedeemPrize(ix: Ix, relayer: PublicKey, player: PublicKey): Checked {
  const name = "redeem_prize_to_evm";
  if (ix.data.length !== 8 + 8) bad("bad-data", `${name}: the instruction data is the wrong size.`);
  if (ix.keys.length !== 14) bad("bad-accounts", `${name} has the wrong number of accounts.`);
  const terms = ix.keys[11]?.pubkey;
  const vault = (terms && vaultOfTerms(terms)) ?? bad("bad-vault", `${name}: that is not a contract we support.`);
  const net = netOfVault(vault);
  const holder = coreAccountPda(player);
  slot(ix, name, 0, true, true, player);
  slot(ix, name, 1, false, false, bridgeStore());
  slot(ix, name, 2, false, false, BRIDGE_AUTHORITY);
  slot(ix, name, 3, false, true);
  slot(ix, name, 4, false, false, sourceAuthPda(net));
  slot(ix, name, 5, false, false, holder);
  slot(ix, name, 6, false, false);
  slot(ix, name, 7, false, true, basketPda(holder));
  slot(ix, name, 8, false, true, spillPda(holder));
  slot(ix, name, 9, false, true);
  slot(ix, name, 10, false, true);
  slot(ix, name, 11, false, false, deliveryTermsPda(vault));
  slot(ix, name, 12, false, false, TESORO_CORE_ID);
  slot(ix, name, 13, false, false, SystemProgram.programId);
  relayerOnlyAt(ix, name, relayer, null);
  return { name, vault, pid: null, signers: [player], holderAccount: holder };
}

/** The listed vault whose Delivery Terms account this is. */
function vaultOfTerms(terms: PublicKey): string | null {
  return ETH_VAULTS.map((v) => v.address as string).find((v) => deliveryTermsPda(v).equals(terms)) ?? null;
}

/** The relayer's one rent transfer: exactly the rent of the account the Redeem creates, to the Player who signs it. */
function checkTransfer(ix: Ix, relayer: PublicKey, player: PublicKey, redeem: Ix): bigint {
  const data = Buffer.from(ix.data);
  const prize = bundleNameOf(redeem.data) === "redeem_prize_to_evm";
  const want = prize ? PAYOUT_RECORD_RENT : CLAIM_RENT;
  if (data.length !== 12 || data.readUInt32LE(0) !== 2 || data.readBigUInt64LE(4) !== want) bad("bad-transfer", "The only transfer we make is the rent of the account a Redeem creates.");
  if (ix.keys.length !== 2) bad("bad-transfer", "The transfer has the wrong number of accounts.");
  slot(ix, "transfer", 0, true, true, relayer);
  slot(ix, "transfer", 1, false, true, player);
  return want;
}

/** Accepts one sponsored transaction made of bridge steps (and the Player's own `unlock`, and the rent transfer) or throws a RuleError. */
export function planBridgeBundle(ixs: Ix[], relayer: PublicKey, player: PublicKey): Plan {
  const names = ixs.map((ix) => {
    if (ix.programId.equals(BRIDGE_ID)) return bundleNameOf(ix.data) ?? bad("unknown-instruction", "That bridge instruction is not one we pay for.");
    if (ix.programId.equals(TESORO_CORE_ID)) return "unlock";
    if (ix.programId.equals(SystemProgram.programId)) return "transfer";
    return bad("unknown-program", "That program is not one we pay for.");
  });
  if (!SHAPES.some((s) => s.length === names.length && s.every((n, i) => n === names[i]))) bad("bad-shape", `${names.join(" + ")} is not a transaction we pay for.`);

  let unlockPlan: Plan | null = null;
  let rent = 0n;
  const checked: Checked[] = [];
  ixs.forEach((ix, i) => {
    const n = names[i];
    if (n === "transfer") {
      rent += checkTransfer(ix, relayer, player, ixs[i + 1]);
      return;
    }
    if (n === "unlock") {
      unlockPlan = planCore([ix], relayer);
      if (unlockPlan.names[0] !== "unlock") bad("bad-shape", "Only an Unlock may travel with the bridge steps.");
      checked.push({ name: "unlock", vault: "", pid: null, signers: [player], corePosition: ix.keys[3].pubkey });
      return;
    }
    const c =
      n === "apply_locked" ? checkApplyLocked(ix, relayer)
      : n === "apply_yield" ? checkApplyYield(ix, relayer)
      : n === "send_unlock" ? checkSendUnlock(ix, relayer)
      : n === "send_pay_yield" ? checkSendPay("yield", ix, relayer, player)
      : n === "send_pay_instant" ? checkSendPay("instant", ix, relayer, player)
      : n === "send_pay_prize" ? checkSendPayPrize(ix, relayer)
      : n === "refund_prize_payout" ? checkRefundPrize(ix, relayer, player)
      : n === "redeem_to_evm" ? checkRedeemToEvm(ix, relayer, player)
      : checkRedeemPrize(ix, relayer, player);
    checked.push(c);
  });

  // The steps of one bundle are about one Position (and one Claim): a send may not point at somebody else's.
  const positions = new Set(checked.flatMap((c) => (c.corePosition ? [c.corePosition.toBase58()] : [])));
  if (positions.size > 1) bad("bad-shape", "The steps of one transaction are for one Lock.");
  const redeem = checked.find((c) => c.name === "redeem_to_evm");
  const sendPay = checked.find((c) => c.name === "send_pay_yield");
  if (redeem && sendPay && !(redeem.claim && sendPay.claim && redeem.claim.equals(sendPay.claim))) bad("bad-shape", "The send must be for the Claim the Redeem records.");
  const vaults = new Set(checked.filter((c) => c.vault).map((c) => c.vault.toLowerCase()));
  if (vaults.size > 1) bad("bad-shape", "The steps of one transaction are for one contract.");

  const sends = checked.flatMap((c) => (c.send ? [c.send] : []));
  const lz = sends.reduce((n, s) => n + s.feeLamports, 0n);
  const cu = Math.min(1_400_000, names.reduce((n, name) => n + (name === "unlock" ? 600_000 : name === "transfer" ? 0 : ROW_CU[name as BundleName]), 0));
  const signers = [...new Map(checked.flatMap((c) => c.signers).map((s) => [s.toBase58(), s])).values()];
  const up = unlockPlan as Plan | null;
  return {
    kind: "core",
    names,
    class: "exit",
    spend: { refundable: 0n, sunk: lz + rent + (up?.spend.sunk ?? 0n) },
    cu,
    obligations: [],
    pair: null,
    signers,
    playerSigns: signers.length > 0,
    funders: [],
    onboarding: false,
    invite: false,
    noGemas: false,
    sends,
  };
}

export const BRIDGE_BUNDLE_SHAPES = SHAPES;
