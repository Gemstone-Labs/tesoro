import "server-only";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2/umi";
import { BRIDGE_ID, bridgePeerPda, bridgeStore, disc, netOfVault } from "@/lib/chain/eth";
import type { SendQuote } from "@/lib/chain/bridge-bundle";
import { BASE_RPC, DemoHttpError, chain, relayerKey } from "./demo-advance";
import { retryingReads } from "./retry";
import type { BridgeSendGuard, SendAccount } from "./sponsor/bridge-sends";

/**
 * LayerZero sends from Solana, for the server: the endpoint's send accounts and the native fee of a message to one vault.
 * Two callers: the `send-quote` step of the relay route (what a Player's page needs to build its own bridge steps) and the
 * sponsor, which checks the Player's instructions against the same list and a fresh quote (./sponsor/bridge-sends.ts).
 */

/** `quote_send` message types (bridge/programs/tesoro_bridge/src/msg_codec.rs). */
export const MSG_TYPE = { unlock: 10, yield: 11, instant: 12, prize: 13 } as const;
export type SendKind = keyof typeof MSG_TYPE;

/** The relay's Solana connection: its reads retry on rate limits and timeouts. */
const proxies = new WeakMap<object, ReturnType<typeof chain>["conn"]>();
export function relayConn() {
  const conn = chain().conn;
  let proxy = proxies.get(conn);
  if (!proxy) proxies.set(conn, (proxy = retryingReads(conn)));
  return proxy;
}

const key = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

let umiCache: { umi: ReturnType<typeof createUmi>; endpoint: EndpointProgram.Endpoint } | null = null;
function lz() {
  if (!umiCache) {
    const relayer = relayerKey();
    const umi = createUmi(BASE_RPC);
    umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(relayer as Keypair))));
    umiCache = { umi, endpoint: new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID) };
  }
  return umiCache;
}

export const endpointSettings = () => toWeb3JsPublicKey(lz().endpoint.pda.setting()[0]);

type Metas = ReturnType<typeof key>[];
const ACCOUNTS_TTL_MS = 10 * 60_000;
const accountCache = new Map<string, { at: number; value: { quote: Metas; send: Metas } }>();

/** The endpoint's quote and send account lists for the bridge OApp (Store PDA) toward one vault, with the relayer as payer. Cached ten minutes. */
export async function sendAccounts(vault: string): Promise<{ quote: Metas; send: Metas }> {
  const hit = accountCache.get(vault.toLowerCase());
  if (hit && Date.now() - hit.at < ACCOUNTS_TTL_MS) return hit.value;
  const { umi, endpoint } = lz();
  const oapp = umiKey(bridgeStore().toBase58());
  const eid = netOfVault(vault).eid;
  const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid);
  if (!lib.programId) throw new DemoHttpError(503, "not-configured", "Cross-chain transfers are not available right now.");
  const receiver = Uint8Array.from(Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"));
  const path = { dstEid: eid, sender: oapp, receiver };
  const msgLibProgram = new UlnProgram.Uln(lib.programId);
  const quoteMetas = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const sendMetas = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const conv = (l: { pubkey: Parameters<typeof toWeb3JsPublicKey>[0]; isSigner: boolean; isWritable: boolean }[]) => l.map((m) => key(toWeb3JsPublicKey(m.pubkey), m.isSigner, m.isWritable));
  const value = { quote: conv(quoteMetas!), send: conv(sendMetas!) };
  accountCache.set(vault.toLowerCase(), { at: Date.now(), value });
  return value;
}

/** The native fee (lamports) LayerZero quotes for a message type to a vault, by a free simulation of `quote_send`. */
export async function quoteFee(vault: string, type: number, quoteMetas: Metas): Promise<bigint> {
  const conn = relayConn();
  const relayer = relayerKey();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [key(bridgeStore()), key(bridgePeerPda(vault)), key(endpointSettings()), ...quoteMetas],
    data: Buffer.concat([disc("quote_send"), u32le(netOfVault(vault).eid), Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"), Buffer.from([type]), u32le(0), Buffer.from([0])]),
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [relayer]);
  if (sim.value.err || !sim.value.returnData) throw new DemoHttpError(502, "chain", "Couldn’t get the cross-chain fee. Try again.");
  return Buffer.from(sim.value.returnData.data[0], "base64").readBigUInt64LE(0);
}

const FEE_TTL_MS = 20_000;
const feeCache = new Map<string, { at: number; fee: bigint }>();
async function quoteCached(vault: string, kind: SendKind): Promise<bigint> {
  const id = `${vault.toLowerCase()}:${kind}`;
  const hit = feeCache.get(id);
  if (hit && Date.now() - hit.at < FEE_TTL_MS) return hit.fee;
  const fee = await quoteFee(vault, MSG_TYPE[kind], (await sendAccounts(vault)).quote);
  feeCache.set(id, { at: Date.now(), fee });
  return fee;
}

/** What the Player's page needs to build the send steps of a transaction for `vault`: `send-quote` answers with this. */
export async function sendQuoteFor(vault: string, kind: SendKind): Promise<SendQuote> {
  const [acc, fee] = [await sendAccounts(vault), await quoteCached(vault, kind)];
  return {
    endpointSettings: endpointSettings().toBase58(),
    payer: relayerKey().publicKey.toBase58(),
    send: acc.send.map((m) => ({ pubkey: m.pubkey.toBase58(), signer: m.isSigner, writable: m.isWritable })),
    feeLamports: fee.toString(),
  };
}

/** The sponsor's check of a Player's send: the same account list and a fresh quote. */
export const bridgeSendGuard: BridgeSendGuard = {
  quote: (vault, msgType) => quoteCached(vault, (Object.keys(MSG_TYPE) as SendKind[]).find((k) => MSG_TYPE[k] === msgType)!),
  sendAccounts: async (vault): Promise<SendAccount[]> => (await sendAccounts(vault)).send.map((m) => ({ pubkey: m.pubkey.toBase58(), signer: m.isSigner, writable: m.isWritable })),
};
