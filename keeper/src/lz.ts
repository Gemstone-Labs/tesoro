import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta, type Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2/umi";
import type { Ctx } from "./act.ts";
import { simulateIxs } from "./tee.ts";

/** tesoro_bridge on Solana devnet and the tesoro_core it feeds. */
export const BRIDGE = new PublicKey("5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ");
export const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const EID_HOODI = 40449;
export const EID_HYPEREVM = 40362;

export const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const accountDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
export const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
export const meta = (pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta => ({ pubkey, isSigner, isWritable });
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const chainByte = (eid: number) => (eid === EID_HOODI ? 1 : eid === EID_HYPEREVM ? 2 : null);
export const eidOf = (chain: string) => (chain === "ethereum" ? EID_HOODI : chain === "hyperEvm" ? EID_HYPEREVM : null);
/** The vault a Position id belongs to, as the 32-byte word the bridge and the peer PDA use. */
export const vaultWord = (positionId: Uint8Array) => {
  const out = Buffer.alloc(32);
  Buffer.from(positionId.subarray(0, 20)).copy(out, 12);
  return out;
};

export const STORE = pda([Buffer.from("Store")], BRIDGE);
export const AUTHORITY = pda([Buffer.from("authority")], BRIDGE);
export const peerPda = (eid: number, positionId: Uint8Array) => pda([Buffer.from("Peer"), STORE.toBuffer(), u32be(eid), vaultWord(positionId)], BRIDGE);
export const bridgePositionPda = (eid: number, positionId: Uint8Array) => pda([Buffer.from("Position"), u32be(eid), Buffer.from(positionId)], BRIDGE);
/** The bridge's mirror of the vault's treasury (`set_peer_config` creates it; `apply_yield` raises it). */
export const vaultTreasuryPda = (eid: number, positionId: Uint8Array) => pda([Buffer.from("treasury"), u32be(eid), vaultWord(positionId)], BRIDGE);
export const evmLinkPda = (evm: Uint8Array) => pda([Buffer.from("evm"), Buffer.from(evm)], BRIDGE);
export const corePda = (...seeds: Buffer[]) => pda(seeds, CORE);
export const sourceAuthPda = (eid: number) => corePda(Buffer.from("source_auth"), Buffer.from([chainByte(eid) ?? 255]));
export const corePositionPda = (eid: number, positionId: Uint8Array) => corePda(Buffer.from("position"), Buffer.from([chainByte(eid) ?? 255]), Buffer.from(positionId));
export const coreSourcePda = (position: PublicKey, index: number) => corePda(Buffer.from("source"), position.toBuffer(), u32le(index));

export const applyLockedIx = (payer: PublicKey, eid: number, positionId: Uint8Array, evmLink: PublicKey, ownerAccount: PublicKey) =>
  new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      meta(payer, true, true),
      meta(STORE),
      meta(peerPda(eid, positionId)),
      meta(bridgePositionPda(eid, positionId), false, true),
      meta(AUTHORITY),
      meta(evmLink),
      meta(ownerAccount),
      meta(sourceAuthPda(eid)),
      meta(corePositionPda(eid, positionId), false, true),
      meta(CORE),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("apply_locked"), u32le(eid), Buffer.from(positionId)]),
  });

/** `openSource`: the Position's open Advance Source (writable), or null when it has none (Debt is zero). */
export const applyYieldIx = (eid: number, positionId: Uint8Array, openSource: PublicKey | null, remaining: AccountMeta[] = []) =>
  new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      meta(STORE),
      meta(peerPda(eid, positionId)),
      meta(bridgePositionPda(eid, positionId), false, true),
      meta(vaultTreasuryPda(eid, positionId), false, true),
      meta(AUTHORITY),
      meta(sourceAuthPda(eid)),
      meta(corePositionPda(eid, positionId), false, true),
      openSource ? meta(openSource, false, true) : meta(BRIDGE),
      meta(CORE),
      // The open Advance's book and checkpoint pages: core lands the yield in them.
      ...remaining,
    ],
    data: Buffer.concat([disc("apply_yield"), u32le(eid), Buffer.from(positionId)]),
  });

// ---- LayerZero sends (Solana to the EVM vault) ------------------------------------------------

const RPC_UMI = (rpc: string, payer: Keypair) => {
  const umi = createUmi(rpc);
  umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(payer))));
  return umi;
};
const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID);
export const ENDPOINT_SETTINGS = toWeb3JsPublicKey(endpoint.pda.setting()[0]);

/** The Endpoint's send and quote account lists for the bridge OApp (Store PDA) toward one vault. */
export async function sendAccounts(ctx: Ctx, eid: number, positionId: Uint8Array) {
  const umi = RPC_UMI(ctx.settings.rpc, ctx.payer);
  const oapp = umiKey(STORE.toBase58());
  const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid);
  if (!lib.programId) throw new Error("send library not initialized");
  const path = { dstEid: eid, sender: oapp, receiver: Uint8Array.from(vaultWord(positionId)) };
  const msgLibProgram = new UlnProgram.Uln(lib.programId);
  const conv = (l: any[]) => l.map((m) => meta(toWeb3JsPublicKey(m.pubkey), m.isSigner, m.isWritable));
  const quote = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const send = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  return { quote: conv(quote!), send: conv(send!) };
}

/** Native fee (lamports) of a message type (3 Unlock, 4 PayYield) via a free simulation of `quote_send`. */
export async function quoteFee(ctx: Ctx, eid: number, positionId: Uint8Array, msgType: number, quoteMetas: AccountMeta[]): Promise<bigint> {
  const ix = new TransactionInstruction({
    programId: BRIDGE,
    keys: [meta(STORE), meta(peerPda(eid, positionId)), meta(ENDPOINT_SETTINGS), ...quoteMetas],
    data: Buffer.concat([disc("quote_send"), u32le(eid), vaultWord(positionId), Buffer.from([msgType]), u32le(0), Buffer.from([0])]),
  });
  const sim = await simulateIxs(ctx.conn, ctx.payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
  if (sim.err || !sim.returnData) throw new Error(`quote failed ${JSON.stringify(sim.err)}`);
  return Buffer.from(sim.returnData.data[0], "base64").readBigUInt64LE(0);
}

/** `send_unlock` / `send_pay_yield` share the trailing `SendParams`: eid, position id, options (empty), fee, lz token fee. */
export const sendParams = (eid: number, positionId: Uint8Array, fee: bigint) =>
  Buffer.concat([u32le(eid), Buffer.from(positionId), u32le(0), u64le(fee), u64le(0n)]);
