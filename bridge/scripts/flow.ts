// Solana-side driver for the ETH flow: the calls the app (or a keeper) makes against tesoro_bridge
// and tesoro_core. Usage: ts-node-transpile-only scripts/flow.ts <cmd> [args]
//   Positions are addressed by <eid> <vault0x> <id> (id = the vault's uint64 position id).
//   core-authority                         admin: register the bridge PDA as Ethereum source authority in tesoro_core
//   create-account <evm0x>                 owner: create the tesoro_core Account with its EVM address
//   link-message                           text the EVM wallet must sign (EIP-191)
//   link <evm0x> <sig0x>                   owner: prove the EVM address and link it
//   init-position <eid> <vault0x> <id>     anyone: create the inbox record before the EVM openPosition
//   state <eid> <vault0x> <id>             inbox + tesoro_core Position + Source
//   apply-locked <eid> <vault0x> <id>      anyone: open the tesoro_core Position from the received PositionLocked
//   advance <eid> <vault0x> <id> <months> <priceMicroUsd>   oracle + owner: take the Advance
//   apply-yield <eid> <vault0x> <id>       anyone: apply the latest received YieldAccrued
//   unlock <eid> <vault0x> <id>            owner: request Unlock in tesoro_core (Debt must be zero)
//   send-unlock <eid> <vault0x> <id>       anyone: send Unlock to the vault
//   redeem <eid> <vault0x> <id> <gemas>    holder: redeem Gemas of the Position's Source, recorded as a claim
//   send-pay-yield <eid> <vault0x> <id>    anyone: send PayYield for the recorded claim
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { createHash } from 'crypto'
import {
    ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from '@metaplex-foundation/umi'
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters'
import { EndpointProgram, UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2/umi'

const BRIDGE = new PublicKey('5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ')
const CORE = new PublicKey('AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh')
const RPC = process.env.SOLANA_RPC ?? 'https://rpc.magicblock.app/devnet'
const connection = new Connection(RPC, 'confirmed')
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace('~', homedir()), 'utf8'))))
const deployer = key(process.env.SOLANA_KEYPAIR ?? '~/.config/solana/dev-2026-10.json')
const owner = key(process.env.OWNER_KEYPAIR ?? '~/.config/tesoro/bridge-demo-owner.json')
const oracle = key(process.env.ORACLE_KEYPAIR ?? '~/.config/tesoro/oracle.json')

const umi = createUmi(RPC)
umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(deployer))))
const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID)
const endpointSettings = toWeb3JsPublicKey(endpoint.pda.setting()[0])

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
const vecU8 = (b: Uint8Array) => Buffer.concat([u32le(b.length), Buffer.from(b)])
const hex = (h: string, len: number) => {
    const b = Buffer.from(h.replace(/^0x/, '').padStart(len * 2, '0'), 'hex')
    if (b.length !== len) throw new Error(`need ${len} bytes`)
    return b
}
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0]
const chainByte = (eid: number) => (eid === 40449 ? 1 : eid === 40362 ? 2 : (() => { throw new Error('unsupported eid') })())
const positionId = (vault: string, id: bigint) => {
    const b = Buffer.alloc(32)
    hex(vault, 20).copy(b, 0)
    b.writeBigUInt64BE(id, 20)
    return b
}
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable })

const store = pda([Buffer.from('Store')], BRIDGE)
const authority = pda([Buffer.from('authority')], BRIDGE)
const corePda = (...s: Buffer[]) => pda(s, CORE)
const configPda = corePda(Buffer.from('config'))
const sourceAuthPda = (eid: number) => corePda(Buffer.from('source_auth'), Buffer.from([chainByte(eid)]))
const peerPda = (eid: number, vault: string) => pda([Buffer.from('Peer'), store.toBuffer(), u32be(eid), hex(vault, 32)], BRIDGE)
const bridgePositionPda = (eid: number, id: Buffer) => pda([Buffer.from('Position'), u32be(eid), id], BRIDGE)
const corePositionPda = (eid: number, id: Buffer) => corePda(Buffer.from('position'), Buffer.from([chainByte(eid)]), id)
const coreAccountPda = (auth: PublicKey) => corePda(Buffer.from('account'), auth.toBuffer())
const sourcePda = (position: PublicKey, index: number) => corePda(Buffer.from('source'), position.toBuffer(), u32le(index))
const holdingPda = (account: PublicKey, source: PublicKey) => corePda(Buffer.from('holding'), account.toBuffer(), source.toBuffer())
const evmLinkPda = (evm: Buffer) => pda([Buffer.from('evm'), evm], BRIDGE)
const claimPda = (account: PublicKey, source: PublicKey) => pda([Buffer.from('claim'), account.toBuffer(), source.toBuffer()], BRIDGE)

async function run(name: string, ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000) {
    const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ...ixs
    )
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    console.log(`${name}: ${sig}`)
    return sig
}

// ---- readers -------------------------------------------------------------------------------
function readBridgePosition(d: Buffer) {
    let o = 8
    const rd = (n: number) => ((o += n), d.subarray(o - n, o))
    const u128 = (b: Buffer) => BigInt('0x' + Buffer.from(b).toString('hex'))
    return {
        eid: rd(4).readUInt32LE(0), positionId: rd(32).toString('hex'), bump: rd(1)[0],
        lastInSeq: rd(8).readBigUInt64LE(0), lockedSeq: rd(8).readBigUInt64LE(0),
        ownerEvm: '0x' + rd(20).toString('hex'), asset: rd(32).toString('hex'),
        principal: u128(Buffer.from(rd(16)).reverse()), horizonMonths: rd(1)[0], opened: rd(1)[0] === 1,
        lastYieldSeq: rd(8).readBigUInt64LE(0), yieldCumulative: u128(Buffer.from(rd(16)).reverse()),
        appliedYieldSeq: rd(8).readBigUInt64LE(0), outSeq: rd(8).readBigUInt64LE(0), unlockSent: rd(1)[0] === 1,
    }
}
function readCorePosition(d: Buffer) {
    let o = 8 + 1 + 32
    const rd = (n: number) => ((o += n), d.subarray(o - n, o))
    const owner = new PublicKey(rd(32)).toBase58(); const chain = rd(1)[0]; rd(32)
    const decimals = rd(1)[0]; const principal = rd(8).readBigUInt64LE(0); const rateBps = rd(2).readUInt16LE(0)
    const status = rd(1)[0]; const advances = rd(4).readUInt32LE(0)
    const hasOpen = rd(1)[0]; const openAdvance = hasOpen ? rd(4).readUInt32LE(0) : null
    const lastSeq = rd(8).readBigUInt64LE(0); const cumulative = rd(8).readBigUInt64LE(0)
    return { owner, chain, decimals, principal, rateBps, status: status === 0 ? 'Locked' : 'Unlocked', advances, openAdvance, lastSeq, cumulative }
}
function readSource(d: Buffer) {
    let o = 8 + 1 + 32 + 32
    const rd = (n: number) => ((o += n), d.subarray(o - n, o))
    const index = rd(4).readUInt32LE(0); rd(1)
    const unitNum = BigInt('0x' + Buffer.from(rd(16)).reverse().toString('hex')); const unitDen = rd(8).readBigUInt64LE(0)
    const issued = rd(8).readBigUInt64LE(0); const returned = rd(8).readBigUInt64LE(0); const redeemed = rd(8).readBigUInt64LE(0)
    const yieldUnits = rd(8).readBigUInt64LE(0); const redeemedUnits = rd(8).readBigUInt64LE(0)
    const live = issued - returned
    const covered = (yieldUnits * unitDen) / unitNum > live ? live : (yieldUnits * unitDen) / unitNum
    return { index, issued, returned, redeemed, yieldUnits, redeemedUnits, debt: live - covered, redeemable: covered - redeemed }
}

async function state(eid: number, vault: string, id: bigint) {
    const pid = positionId(vault, id)
    const bp = await connection.getAccountInfo(bridgePositionPda(eid, pid))
    console.log('bridge position', bridgePositionPda(eid, pid).toBase58(), bp ? JSON.stringify(readBridgePosition(bp.data), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : 'missing')
    const cpPk = corePositionPda(eid, pid)
    const cp = await connection.getAccountInfo(cpPk)
    console.log('core position  ', cpPk.toBase58(), cp ? 'exists' : 'missing')
    if (!cp) return
    const pos = readCorePosition(cp.data)
    console.log(JSON.stringify(pos, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    for (let i = 0; i < pos.advances; i++) {
        const sPk = sourcePda(cpPk, i)
        const s = await connection.getAccountInfo(sPk)
        if (s) console.log('source', sPk.toBase58(), JSON.stringify(readSource(s.data), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    }
}

async function openAdvanceSource(cpPk: PublicKey): Promise<PublicKey | null> {
    const cp = await connection.getAccountInfo(cpPk)
    if (!cp) throw new Error('core position missing')
    const pos = readCorePosition(cp.data)
    return pos.openAdvance === null ? null : sourcePda(cpPk, pos.openAdvance)
}

// ---- LayerZero send accounts ----------------------------------------------------------------
async function sendAccounts(eid: number, vault: string) {
    const oapp = umiKey(store.toBase58())
    const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid)
    if (!lib.programId) throw new Error('send library not initialized')
    const path = { dstEid: eid, sender: oapp, receiver: Uint8Array.from(hex(vault, 32)) }
    const msgLibProgram = new UlnProgram.Uln(lib.programId)
    const quoteMetas = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram })
    const sendMetas = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram })
    const conv = (l: any[]) => l.map((m) => meta(toWeb3JsPublicKey(m.pubkey), m.isSigner, m.isWritable))
    return { quote: conv(quoteMetas!), send: conv(sendMetas!) }
}

async function quoteFee(eid: number, vault: string, type: number, quoteMetas: any[]) {
    const ix = new TransactionInstruction({
        programId: BRIDGE,
        keys: [meta(store), meta(peerPda(eid, vault)), meta(endpointSettings), ...quoteMetas],
        data: Buffer.concat([disc('quote_send'), u32le(eid), hex(vault, 32), Buffer.from([type]), vecU8(new Uint8Array(0)), Buffer.from([0])]),
    })
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix)
    tx.feePayer = deployer.publicKey
    const sim = await connection.simulateTransaction(tx, [deployer])
    if (sim.value.err || !sim.value.returnData) throw new Error(`quote failed ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.join('\n')}`)
    return Buffer.from(sim.value.returnData.data[0], 'base64').readBigUInt64LE(0)
}

const sendParams = (eid: number, pid: Buffer, fee: bigint) =>
    Buffer.concat([u32le(eid), pid, vecU8(new Uint8Array(0)), u64le(fee), u64le(0n)])

// ---- commands -------------------------------------------------------------------------------
async function main() {
    const [cmd, ...a] = process.argv.slice(2)
    const eid = Number(a[0])
    const vault = a[1]
    const id = a[2] !== undefined ? BigInt(a[2]) : 0n
    const ownerAccount = coreAccountPda(owner.publicKey)
    switch (cmd) {
        case 'core-authority': {
            const ix = new TransactionInstruction({
                programId: CORE,
                keys: [meta(deployer.publicKey, true, true), meta(configPda), meta(sourceAuthPda(40449), false, true), meta(SystemProgram.programId)],
                data: Buffer.concat([disc('set_source_authority'), Buffer.from([1]), authority.toBuffer()]),
            })
            const ix2 = new TransactionInstruction({
                programId: CORE,
                keys: [meta(deployer.publicKey, true, true), meta(configPda), meta(sourceAuthPda(40362), false, true), meta(SystemProgram.programId)],
                data: Buffer.concat([disc('set_source_authority'), Buffer.from([2]), authority.toBuffer()]),
            })
            console.log('bridge authority PDA', authority.toBase58())
            return void (await run('set_source_authority (Ethereum, HyperEVM)', [ix, ix2], [deployer]))
        }
        case 'create-account': {
            const ix = new TransactionInstruction({
                programId: CORE,
                keys: [meta(owner.publicKey, true, true), meta(ownerAccount, false, true), meta(SystemProgram.programId)],
                data: Buffer.concat([disc('create_account'), hex(a[0], 20)]),
            })
            console.log('owner', owner.publicKey.toBase58(), 'account', ownerAccount.toBase58())
            return void (await run('create_account', [ix], [owner]))
        }
        case 'link-message': return console.log(`Tesoro: link EVM address to Account ${ownerAccount.toBase58()}`)
        case 'link': {
            const evm = hex(a[0], 20)
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [meta(owner.publicKey, true, true), meta(ownerAccount), meta(evmLinkPda(evm), false, true), meta(SystemProgram.programId)],
                data: Buffer.concat([disc('link_evm'), evm, hex(a[1], 65)]),
            })
            return void (await run('link_evm', [ix], [owner]))
        }
        case 'init-position': {
            const pid = positionId(vault, id)
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [meta(deployer.publicKey, true, true), meta(peerPda(eid, vault)), meta(store), meta(bridgePositionPda(eid, pid), false, true), meta(SystemProgram.programId)],
                data: Buffer.concat([disc('init_position'), u32le(eid), pid]),
            })
            console.log('position id', '0x' + pid.toString('hex'))
            return void (await run('init_position', [ix], [deployer]))
        }
        case 'state': return state(eid, vault, id)
        case 'apply-locked': {
            const pid = positionId(vault, id)
            const bp = readBridgePosition((await connection.getAccountInfo(bridgePositionPda(eid, pid)))!.data)
            const link = evmLinkPda(hex(bp.ownerEvm, 20))
            const linkInfo = await connection.getAccountInfo(link)
            if (!linkInfo) throw new Error('owner EVM address is not linked')
            const account = new PublicKey(linkInfo.data.subarray(8 + 20, 8 + 52))
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [
                    meta(deployer.publicKey, true, true), meta(store), meta(peerPda(eid, vault)), meta(bridgePositionPda(eid, pid), false, true),
                    meta(authority), meta(link), meta(account), meta(sourceAuthPda(eid)), meta(corePositionPda(eid, pid), false, true), meta(CORE), meta(SystemProgram.programId),
                ],
                data: Buffer.concat([disc('apply_locked'), u32le(eid), pid]),
            })
            return void (await run('apply_locked', [ix], [deployer]))
        }
        case 'advance': {
            const pid = positionId(vault, id)
            const cp = corePositionPda(eid, pid)
            const idx = readCorePosition((await connection.getAccountInfo(cp))!.data).advances
            const source = sourcePda(cp, idx)
            const ix = new TransactionInstruction({
                programId: CORE,
                keys: [
                    meta(oracle.publicKey, true, true), meta(owner.publicKey, true), meta(configPda), meta(ownerAccount, false, true),
                    meta(cp, false, true), meta(source, false, true), meta(holdingPda(ownerAccount, source), false, true), meta(SystemProgram.programId),
                ],
                data: Buffer.concat([disc('take_advance'), Buffer.from([Number(a[3])]), u64le(BigInt(a[4]))]),
            })
            return void (await run('take_advance', [ix], [oracle, owner]))
        }
        case 'apply-yield': {
            const pid = positionId(vault, id)
            const cp = corePositionPda(eid, pid)
            const src = await openAdvanceSource(cp)
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [
                    meta(store), meta(bridgePositionPda(eid, pid), false, true), meta(authority), meta(sourceAuthPda(eid)), meta(cp, false, true),
                    src ? meta(src, false, true) : meta(BRIDGE), meta(CORE),
                ],
                data: Buffer.concat([disc('apply_yield'), u32le(eid), pid]),
            })
            return void (await run('apply_yield', [ix], [deployer]))
        }
        case 'unlock': {
            const pid = positionId(vault, id)
            const ix = new TransactionInstruction({
                programId: CORE,
                keys: [meta(owner.publicKey, true), meta(ownerAccount), meta(corePositionPda(eid, pid), false, true)],
                data: disc('unlock'),
            })
            return void (await run('core unlock', [ix], [deployer, owner]))
        }
        case 'send-unlock': {
            const pid = positionId(vault, id)
            const acc = await sendAccounts(eid, vault)
            const fee = await quoteFee(eid, vault, 3, acc.quote)
            console.log('fee lamports', fee.toString())
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [
                    meta(deployer.publicKey, true, true), meta(peerPda(eid, vault)), meta(store), meta(bridgePositionPda(eid, pid), false, true),
                    meta(corePositionPda(eid, pid)), meta(endpointSettings), meta(SystemProgram.programId), ...acc.send,
                ],
                data: Buffer.concat([disc('send_unlock'), sendParams(eid, pid, fee)]),
            })
            return void (await run('send_unlock', [ix], [deployer], 600_000))
        }
        case 'redeem': {
            const pid = positionId(vault, id)
            const cp = corePositionPda(eid, pid)
            const idx = readCorePosition((await connection.getAccountInfo(cp))!.data).advances - 1
            const source = sourcePda(cp, idx)
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [
                    meta(owner.publicKey, true, true), meta(store), meta(authority), meta(sourceAuthPda(eid)),
                    meta(ownerAccount, false, true), meta(cp), meta(source, false, true),
                    meta(holdingPda(ownerAccount, source), false, true), meta(claimPda(ownerAccount, source), false, true), meta(CORE), meta(SystemProgram.programId),
                ],
                data: Buffer.concat([disc('redeem_to_evm'), u64le(BigInt(a[3]))]),
            })
            return void (await run('redeem_to_evm', [ix], [owner]))
        }
        case 'send-pay-yield': {
            const pid = positionId(vault, id)
            const cp = corePositionPda(eid, pid)
            const idx = readCorePosition((await connection.getAccountInfo(cp))!.data).advances - 1
            const source = sourcePda(cp, idx)
            const acct = await connection.getAccountInfo(ownerAccount)
            const evm = Buffer.from(acct!.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 20))
            const acc = await sendAccounts(eid, vault)
            const fee = await quoteFee(eid, vault, 4, acc.quote)
            console.log('fee lamports', fee.toString())
            const ix = new TransactionInstruction({
                programId: BRIDGE,
                keys: [
                    meta(deployer.publicKey, true, true), meta(peerPda(eid, vault)), meta(store), meta(bridgePositionPda(eid, pid), false, true),
                    meta(cp), meta(ownerAccount), meta(evmLinkPda(evm)), meta(claimPda(ownerAccount, source), false, true),
                    meta(endpointSettings), meta(SystemProgram.programId), ...acc.send,
                ],
                data: Buffer.concat([disc('send_pay_yield'), sendParams(eid, pid, fee)]),
            })
            return void (await run('send_pay_yield', [ix], [deployer], 600_000))
        }
        default: throw new Error('unknown command')
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
