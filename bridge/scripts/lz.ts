// Driver for the tesoro_bridge LayerZero wiring. Usage:
//   ts-node-transpile-only scripts/lz.ts <cmd> [args]
//   init                                   register the Store PDA as an OApp (delegate = payer)
//   wire <eid> <vault0x> <decimals> <rateBps>   PeerConfig for one EVM vault + endpoint nonce/send/receive lib init (+ ULN config init)
//   defaults <eid>                         default send/receive ULN + executor config for the pathway
//   config <eid>                           the OApp's effective (resolved) config
//   set-uln <eid> <dvnBase58> <sendConf> <recvConf>
//   quote <eid> <vault0x> <type 3|4>       fee for one outbound message
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { createHash } from 'crypto'

import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import { fromWeb3JsPublicKey, toWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from '@metaplex-foundation/umi'
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters'
import { Options } from '@layerzerolabs/lz-v2-utilities'

import { EndpointProgram, UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2/umi'

const PROGRAM_ID = new PublicKey('5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ')
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`, 'utf8')))
)

const umi = createUmi(RPC)
const umiSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(payer))
umi.use(signerIdentity(umiSigner))

const umiProgramId = fromWeb3JsPublicKey(PROGRAM_ID)
const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID)
const uln = new UlnProgram.Uln(UlnProgram.ULN_PROGRAM_ID)
const store = PublicKey.findProgramAddressSync([Buffer.from('Store')], PROGRAM_ID)[0]
const lzReceiveTypes = PublicKey.findProgramAddressSync([Buffer.from('LzReceiveTypes'), store.toBuffer()], PROGRAM_ID)[0]

// Endpoint-side pathway initialisation, all signed by the delegate (= admin = payer in the spike).
const initOAppNonce = (a: { admin: any; oapp: any }, eid: number, peer: Uint8Array) =>
    endpoint.initOAppNonce(a.admin, { localOApp: a.oapp, remote: eid, remoteOApp: peer })
const initSendLibrary = (a: { admin: any; oapp: any }, eid: number) =>
    endpoint.initOAppSendLibrary(a.admin, { sender: a.oapp, remote: eid })
const initReceiveLibrary = (a: { admin: any; oapp: any }, eid: number) =>
    endpoint.initOAppReceiveLibrary(a.admin, { receiver: a.oapp, remote: eid })
const initConfig = (_p: unknown, a: { admin: any; payer: any }, eid: number) =>
    endpoint.initOAppConfig(
        { delegate: a.admin, payer: a.payer.publicKey },
        { msgLibSDK: uln, oapp: umiKey(store.toBase58()), remote: eid }
    )

// Enforced options applied when Solana sends to an EVM peer (lzReceive gas on the EVM side).
const EVM_RECEIVE_GAS = Number(process.env.EVM_RECEIVE_GAS ?? 250_000)

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u32be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const u64le = (n: bigint) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(n)
    return b
}
const u128be = (n: bigint) => Buffer.from(n.toString(16).padStart(32, '0'), 'hex')
const vecU8 = (b: Uint8Array) => Buffer.concat([Buffer.from(new Uint32Array([b.length]).buffer), Buffer.from(b)])
const hex32 = (h: string) => {
    const b = Buffer.from(h.replace(/^0x/, '').padStart(64, '0'), 'hex')
    if (b.length !== 32) throw new Error('need 32 bytes')
    return b
}
const peerPda = (eid: number, peer: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from('Peer'), store.toBuffer(), u32be(eid), peer], PROGRAM_ID)[0]
const um2web = (w: any) => toWeb3JsInstruction(w.instruction ?? w)

async function run(name: string, ixs: TransactionInstruction[], cu = 400_000) {
    const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ...ixs
    )
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' })
    console.log(`${name}: ${sig}`)
    return sig
}

function evmOptions(): Uint8Array {
    return Options.newOptions().addExecutorLzReceiveOption(EVM_RECEIVE_GAS, 0).toBytes()
}

async function init() {
    const remaining = endpoint.getRegisterOappIxAccountMetaForCPI(umiSigner.publicKey, umiKey(store.toBase58()))
    const data = Buffer.concat([disc('init_store'), payer.publicKey.toBuffer(), toWeb3JsPublicKey(endpoint.programId).toBuffer()])
    const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: store, isSigner: false, isWritable: true },
            { pubkey: lzReceiveTypes, isSigner: false, isWritable: true },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // alt = None
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ...remaining.map((m) => ({ pubkey: toWeb3JsPublicKey(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable })),
        ],
        data,
    })
    await run('init_store', [ix])
    console.log('store PDA (OApp address / peer address on EVM):', store.toBase58(), '0x' + store.toBuffer().toString('hex'))
}

function setPeerIx(eid: number, peer: Buffer, decimals: number, rateBps: number) {
    const rate = Buffer.alloc(2)
    rate.writeUInt16LE(rateBps)
    return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: peerPda(eid, peer), isSigner: false, isWritable: true },
            { pubkey: store, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
            disc('set_peer_config'),
            Buffer.from(new Uint32Array([eid]).buffer),
            peer,
            Buffer.from([decimals]),
            rate,
            vecU8(evmOptions()),
        ]),
    })
}

async function wire(eid: number, vaultHex: string, decimals: number, rateBps: number) {
    const peer = hex32(vaultHex)
    const oapp = umiKey(store.toBase58())
    const signer = umiSigner
    await run('set_peer_config', [setPeerIx(eid, peer, decimals, rateBps)])

    const ixs: TransactionInstruction[] = []
    const nonceInfo = await connection.getAccountInfo(toWeb3JsPublicKey(endpoint.pda.nonce(oapp, eid, peer)[0]))
    if (!nonceInfo) ixs.push(um2web(initOAppNonce({ admin: signer, oapp }, eid, peer)))
    const sendLibInfo = await connection.getAccountInfo(toWeb3JsPublicKey(endpoint.pda.sendLibraryConfig(oapp, eid)[0]))
    if (!sendLibInfo) ixs.push(um2web(initSendLibrary({ admin: signer, oapp }, eid)))
    const recvLibInfo = await connection.getAccountInfo(toWeb3JsPublicKey(endpoint.pda.receiveLibraryConfig(oapp, eid)[0]))
    if (!recvLibInfo) ixs.push(um2web(initReceiveLibrary({ admin: signer, oapp }, eid)))
    if (ixs.length) await run('endpoint_init_oapp_pathway', ixs)
    const cfg = await connection.getAccountInfo(toWeb3JsPublicKey(uln.pda.sendConfig(eid, oapp)[0]))
    if (!cfg) await run('uln_init_config', [um2web(initConfig(umiProgramId, { admin: signer, payer: signer }, eid))])
}

function fmtUln(c: any) {
    if (!c) return null
    return JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function defaults(eid: number) {
    const rpc = umi.rpc
    const [s, r] = await Promise.all([uln.getDefaultSendConfigState(rpc, eid), uln.getDefaultReceiveConfigState(rpc, eid)])
    console.log('default send  :', JSON.stringify(fmtUln(s)))
    console.log('default recv  :', JSON.stringify(fmtUln(r)))
    console.log('default send lib:', JSON.stringify(fmtUln(await endpoint.getDefaultSendLibrary(rpc, eid))))
    console.log('default recv lib:', JSON.stringify(fmtUln(await endpoint.getDefaultReceiveLibrary(rpc, eid))))
}

async function config(eid: number) {
    const rpc = umi.rpc
    const oapp = umiKey(store.toBase58())
    console.log('send  :', JSON.stringify(fmtUln(await uln.getSendConfigState(rpc, oapp, eid))))
    console.log('recv  :', JSON.stringify(fmtUln(await uln.getReceiveConfigState(rpc, oapp, eid))))
    console.log('final send:', JSON.stringify(fmtUln(await uln.getFinalSendConfigState(rpc, oapp, eid))))
    console.log('final recv:', JSON.stringify(fmtUln(await uln.getFinalReceiveConfigState(rpc, oapp, eid))))
    console.log('send lib:', JSON.stringify(fmtUln(await endpoint.getSendLibrary(rpc, oapp, eid))))
}

async function setUln(eid: number, dvn: string, sendConf: number, recvConf: number) {
    const rpc = umi.rpc
    const oapp = umiKey(store.toBase58())
    const mk = (confirmations: number) => ({
        confirmations: BigInt(confirmations),
        requiredDvnCount: 1,
        optionalDvnCount: 0,
        optionalDvnThreshold: 0,
        requiredDvns: [umiKey(dvn)],
        optionalDvns: [],
    })
    const ixs = [
        await endpoint.setOAppConfig(rpc, umiSigner, {
            oapp,
            eid,
            msgLibProgram: UlnProgram.ULN_PROGRAM_ID,
            config: { configType: EndpointProgram.types.SetConfigType.SendUln, value: mk(sendConf) as any },
        }),
        await endpoint.setOAppConfig(rpc, umiSigner, {
            oapp,
            eid,
            msgLibProgram: UlnProgram.ULN_PROGRAM_ID,
            config: { configType: EndpointProgram.types.SetConfigType.ReceiveUln, value: mk(recvConf) as any },
        }),
    ].map(um2web)
    await run('set_uln_config', ixs)
}

async function quote(eid: number, vaultHex: string, type: number) {
    const peer = hex32(vaultHex)
    const oapp = umiKey(store.toBase58())
    const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid)
    if (!lib.programId) throw new Error('send library not initialized')
    const path = { dstEid: eid, sender: oapp, receiver: Uint8Array.from(peer) }
    const remaining = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umiSigner.publicKey, { path, msgLibProgram: new UlnProgram.Uln(lib.programId) })
    const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: store, isSigner: false, isWritable: false },
            { pubkey: peerPda(eid, peer), isSigner: false, isWritable: false },
            { pubkey: toWeb3JsPublicKey(endpoint.pda.setting()[0]), isSigner: false, isWritable: false },
            ...remaining!.map((m) => ({ pubkey: toWeb3JsPublicKey(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable })),
        ],
        data: Buffer.concat([disc('quote_send'), Buffer.from(new Uint32Array([eid]).buffer), peer, Buffer.from([type]), vecU8(new Uint8Array(0)), Buffer.from([0])]),
    })
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix)
    tx.feePayer = payer.publicKey
    const sim = await connection.simulateTransaction(tx, [payer])
    if (sim.value.err || !sim.value.returnData) {
        console.log(sim.value.logs?.join('\n'))
        throw new Error(`quote failed ${JSON.stringify(sim.value.err)}`)
    }
    const b = Buffer.from(sim.value.returnData.data[0], 'base64')
    console.log(`quote eid ${eid} type ${type}: native_fee=${b.readBigUInt64LE(0)} lamports`)
}

async function main() {
    const [cmd, ...a] = process.argv.slice(2)
    switch (cmd) {
        case 'init': return init()
        case 'wire': return wire(Number(a[0]), a[1], Number(a[2]), Number(a[3]))
        case 'defaults': return defaults(Number(a[0]))
        case 'config': return config(Number(a[0]))
        case 'set-uln': return setUln(Number(a[0]), a[1], Number(a[2]), Number(a[3]))
        case 'quote': return quote(Number(a[0]), a[1], Number(a[2]))
        default: throw new Error('unknown command')
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
