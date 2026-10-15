/**
 * LayerZero mainnet wiring for one pathway: tesoro_bridge on Solana mainnet <-> a PositionVaultOApp on Ethereum or HyperEVM.
 * DRY RUN BY DEFAULT: prints every Solana instruction and every EVM call and sends nothing. `--execute` sends the Solana
 * steps only (signed by the LayerZero delegate keypair); the EVM steps are always printed as calldata for the vault owner
 * (a Safe), never sent here. `--verify` reads the pathway back (Solana via the SDK, EVM via `cast call`) and compares it
 * with the plan. Nothing in the repo runs this against mainnet; see docs/cross-chain.md "Mainnet wiring".
 *
 *   pnpm lz-mainnet --pathway ethereum|hyperevm --vault 0x<PositionVaultOApp> --delegate <SOLANA_DELEGATE_PUBKEY> \
 *     --safe 0x<VAULT_OWNER_AND_EVM_DELEGATE> --decimals 18 --rate-bps <bps> \
 *     [--program-id <tesoro_bridge>] [--dvns layerzero-labs,nethermind] [--rpc <solana url>] [--evm-rpc <url>] \
 *     [--send-confirmations N --receive-confirmations N] [--evm-receive-gas 250000] [--safe-json out.json] \
 *     [--verify] [--execute --keypair <delegate keypair file>]
 *
 * Steps (Solana): init_store (once), set_peer_config, endpoint pathway init, ULN config init, pin send/receive library,
 * executor + send ULN + receive ULN config. Steps (EVM, by the Safe): setPeer, setSendLibrary, setReceiveLibrary, setConfig
 * (executor + send ULN), setConfig (receive ULN). Sources for every address and number: docs/cross-chain.md "Mainnet wiring".
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createNoopSigner, publicKey as umiKey } from '@metaplex-foundation/umi'
import { toWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { Options } from '@layerzerolabs/lz-v2-utilities'
import { EndpointProgram, SetConfigType, UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2/umi'

// ---------------------------------------------------------------------------------------------------------------------
// Constants. Source: https://metadata.layerzero-api.com/v1/metadata (deployments, dvns), read 2026-10-15, and on chain.
// ---------------------------------------------------------------------------------------------------------------------
const SOLANA_EID = 30168
const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const COMPROMISED = 'AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV'
const DEFAULT_BRIDGE = '5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ'
const ZERO = '0x0000000000000000000000000000000000000000'

type DvnSet = Record<string, string> // id -> address on that chain

const SOLANA_DVNS: DvnSet = {
  'layerzero-labs': '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb',
  nethermind: 'GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab',
  canary: '7jMeX5mzXnSSKYd8DxBDP4xMnkNFZZZm5W28FWUTbwU3',
  'horizen-labs': 'HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX',
}
const SOLANA = {
  uln: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', // sendUln302 = receiveUln302 on Solana
  executor: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', // default executor PDA
  executorMaxMessageSize: 10_000,
}

interface Evm {
  name: string
  eid: number
  chainId: number
  endpoint: string
  sendUln302: string
  receiveUln302: string
  executor: string
  executorMaxMessageSize: number
  dvns: DvnSet
  rpc: string
  // Confirmations the DVNs wait before verifying. `send` = EVM -> Solana (set on the EVM send lib, mirrored on the Solana
  // receive lib); `receive` = Solana -> EVM (set on the Solana send lib, mirrored on the EVM receive lib).
  send: number
  receive: number
}
const EVM: Record<string, Evm> = {
  ethereum: {
    name: 'Ethereum',
    eid: 30101,
    chainId: 1,
    endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
    sendUln302: '0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1',
    receiveUln302: '0xc02Ab410f0734EFa3F14628780e6e695156024C2',
    executor: '0x173272739Bd7Aa6e4e214714048a9fE699453059',
    executorMaxMessageSize: 200,
    dvns: {
      'layerzero-labs': '0x589dEDbD617e0CBcB916A9223F4d1300c294236b',
      nethermind: '0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5',
      canary: '0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd',
      'horizen-labs': '0x380275805876Ff19055EA900CDb2B46a94ecF20D',
    },
    rpc: 'https://ethereum-rpc.publicnode.com',
    send: 15,
    receive: 32,
  },
  hyperevm: {
    name: 'HyperEVM',
    eid: 30367,
    chainId: 999,
    endpoint: '0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9',
    sendUln302: '0xfd76d9CB0Bac839725aB79127E7411fe71b1e3CA',
    receiveUln302: '0x7cacBe439EaD55fa1c22790330b12835c6884a91',
    executor: '0x41Bdb4aa4A63a5b2Efc531858d3118392B1A1C3d',
    executorMaxMessageSize: 200,
    dvns: {
      'layerzero-labs': '0xc097ab8CD7b053326DFe9fB3E3a31a0CCe3B526f',
      nethermind: '0x8E49eF1DfAe17e547CA0E7526FfDA81FbaCA810A',
      canary: '0x83342EC538dF0460e730a8F543Fe63063e2D44C4',
      'horizen-labs': '0xBB83Ecf372CbB6daa629ea9A9A53BEC6d601F229',
    },
    rpc: 'https://rpc.hyperliquid.xyz/evm',
    send: 1,
    receive: 32,
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const one = (n: string) => argv[argv.indexOf(`--${n}`) + 1] && argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined
const need = (n: string) => {
  const v = one(n)
  if (!v) throw new Error(`--${n} is required`)
  return v
}
const num = (n: string, d?: number) => {
  const v = one(n)
  if (v === undefined) {
    if (d === undefined) throw new Error(`--${n} is required`)
    return d
  }
  const x = Number(v)
  if (!Number.isInteger(x) || x < 0) throw new Error(`--${n} must be a non-negative integer`)
  return x
}
const evmAddr = (n: string) => {
  const v = need(n)
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`--${n} is not an EVM address`)
  return v
}

const pathwayName = need('pathway')
const evm = EVM[pathwayName]
if (!evm) throw new Error(`--pathway must be one of ${Object.keys(EVM).join(', ')}`)
const vault = evmAddr('vault')
const safe = evmAddr('safe')
const delegate = new PublicKey(need('delegate'))
if (delegate.toBase58() === COMPROMISED) throw new Error('--delegate is the compromised key; never use it')
const programId = new PublicKey(one('program-id') ?? DEFAULT_BRIDGE)
const decimals = num('decimals')
const rateBps = num('rate-bps')
if (rateBps > 0xffff || decimals > 255) throw new Error('--rate-bps must fit u16 and --decimals u8')
const evmReceiveGas = num('evm-receive-gas', 250_000) // Solana -> EVM lzReceive gas; testnet value (bridge/scripts/lz.ts)
const sendConf = num('send-confirmations', evm.send)
const recvConf = num('receive-confirmations', evm.receive)
const dvnIds = (one('dvns') ?? 'layerzero-labs,nethermind').split(',')
if (dvnIds.length < 2 || new Set(dvnIds).size !== dvnIds.length) throw new Error('--dvns needs at least two distinct ids')
for (const id of dvnIds) if (!SOLANA_DVNS[id] || !evm.dvns[id]) throw new Error(`unknown DVN id ${id}; known: ${Object.keys(SOLANA_DVNS).join(', ')}`)
const execute = flag('execute')
const verify = flag('verify')
const evmRpc = one('evm-rpc') ?? evm.rpc
const solRpc = one('rpc')

// ---------------------------------------------------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------------------------------------------------
const store = PublicKey.findProgramAddressSync([Buffer.from('Store')], programId)[0]
const lzReceiveTypes = PublicKey.findProgramAddressSync([Buffer.from('LzReceiveTypes'), store.toBuffer()], programId)[0]
const storeHex = '0x' + store.toBuffer().toString('hex')
const vaultBytes32 = Buffer.concat([Buffer.alloc(12), Buffer.from(vault.slice(2), 'hex')])
const vaultHex32 = '0x' + vaultBytes32.toString('hex')
const u32be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const peerPda = PublicKey.findProgramAddressSync([Buffer.from('Peer'), store.toBuffer(), u32be(evm.eid), vaultBytes32], programId)[0]
const treasuryPda = PublicKey.findProgramAddressSync([Buffer.from('treasury'), u32be(evm.eid), vaultBytes32], programId)[0]
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const vecU8 = (b: Uint8Array) => Buffer.concat([Buffer.from(new Uint32Array([b.length]).buffer), Buffer.from(b)])
const enforcedOptions = Buffer.from(Options.newOptions().addExecutorLzReceiveOption(evmReceiveGas, 0).toBytes())

const solDvns = dvnIds.map((id) => new PublicKey(SOLANA_DVNS[id])).sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()))
const evmDvns = dvnIds.map((id) => evm.dvns[id]).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))

const umi = createUmi(solRpc ?? 'https://api.mainnet-beta.solana.com') // no request is made unless --rpc reads or --execute run
const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID)
const uln = new UlnProgram.Uln(UlnProgram.ULN_PROGRAM_ID)
const oapp = umiKey(store.toBase58())
const delegateSigner = createNoopSigner(umiKey(delegate.toBase58()))
const um2web = (w: any) => toWeb3JsInstruction(w.instruction ?? w)
const ulnConfig = (confirmations: number) => ({
  confirmations: BigInt(confirmations),
  requiredDvnCount: solDvns.length,
  optionalDvnCount: 0,
  optionalDvnThreshold: 0,
  requiredDvns: solDvns.map((k) => umiKey(k.toBase58())),
  optionalDvns: [],
})
const ulnProgram = umiKey(SOLANA.uln)
const ulnVersion = { major: 3n, minor: 0, endpointVersion: 2 } as any

// ---------------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------------
interface SolStep { kind: 'solana'; title: string; note: string; ixs: TransactionInstruction[]; cu: number; check?: () => Promise<boolean> }
interface EvmStep { kind: 'evm'; title: string; note: string; to: string; sig: string; args: string[]; data: string }
type Step = SolStep | EvmStep

const cast = (...a: string[]) => execFileSync('cast', a, { encoding: 'utf8' }).trim()
const castCalldata = (sig: string, args: string[]) => cast('calldata', sig, ...args)

async function buildSolana(): Promise<SolStep[]> {
  const registerAccounts = endpoint.getRegisterOappIxAccountMetaForCPI(delegateSigner.publicKey, oapp)
  const initStore = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: delegate, isSigner: true, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: true },
      { pubkey: lzReceiveTypes, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...registerAccounts.map((m) => ({ pubkey: toWeb3JsPublicKey(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable })),
    ],
    data: Buffer.concat([disc('init_store'), delegate.toBuffer(), toWeb3JsPublicKey(endpoint.programId).toBuffer()]),
  })
  const rate = Buffer.alloc(2)
  rate.writeUInt16LE(rateBps)
  const setPeer = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: delegate, isSigner: true, isWritable: true },
      { pubkey: peerPda, isSigner: false, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // disc | remote_eid u32 LE | peer 32 | decimals | rate_bps u16 LE | enforced options (Borsh vec)
    data: Buffer.concat([disc('set_peer_config'), Buffer.from(new Uint32Array([evm.eid]).buffer), vaultBytes32, Buffer.from([decimals]), rate, vecU8(enforcedOptions)]),
  })

  const pathwayInit = [
    endpoint.initOAppNonce(delegateSigner, { localOApp: oapp, remote: evm.eid, remoteOApp: Uint8Array.from(vaultBytes32) }),
    endpoint.initOAppSendLibrary(delegateSigner, { sender: oapp, remote: evm.eid }),
    endpoint.initOAppReceiveLibrary(delegateSigner, { receiver: oapp, remote: evm.eid }),
  ].map(um2web)
  const ulnInit = um2web(endpoint.initOAppConfig({ delegate: delegateSigner, payer: delegateSigner.publicKey }, { msgLibSDK: uln, oapp, remote: evm.eid }))
  const pin = [
    endpoint.setOAppSendLibrary(delegateSigner, { sender: oapp, remote: evm.eid, msgLibProgram: ulnProgram }),
    endpoint.setOAppReceiveLibrary(delegateSigner, { receiver: oapp, remote: evm.eid, msgLibProgram: ulnProgram, gracePeriod: 0 }),
  ].map(um2web)
  const setCfg = async (configType: any, value: any) =>
    um2web(await endpoint.setOAppConfig(umi.rpc, delegateSigner, { oapp, eid: evm.eid, msgLibProgram: ulnProgram, msgLibVersion: ulnVersion, config: { configType, value } }))
  const T = SetConfigType
  const cfg = [
    await setCfg(T.EXECUTOR, { maxMessageSize: SOLANA.executorMaxMessageSize, executor: umiKey(SOLANA.executor) }),
    await setCfg(T.SEND_ULN, ulnConfig(recvConf)),
    await setCfg(T.RECEIVE_ULN, ulnConfig(sendConf)),
  ]
  return [
    { kind: 'solana', title: 'tesoro_bridge init_store (once for the whole bridge, skip on the second pathway)', note: `Store ${store.toBase58()} (peer address on EVM ${storeHex}); admin and endpoint delegate = ${delegate.toBase58()}`, ixs: [initStore], cu: 400_000 },
    { kind: 'solana', title: `tesoro_bridge set_peer_config eid ${evm.eid}`, note: `vault ${vault}, decimals ${decimals}, rate ${rateBps} bps, enforced send options type-3 lzReceive gas ${evmReceiveGas} (0x${enforcedOptions.toString('hex')}); also creates VaultTreasury ${treasuryPda.toBase58()}`, ixs: [setPeer], cu: 400_000 },
    { kind: 'solana', title: `endpoint pathway init (nonce, send library, receive library) for eid ${evm.eid}`, note: `remote OApp ${vaultHex32}`, ixs: pathwayInit, cu: 400_000 },
    { kind: 'solana', title: `ULN config init for eid ${evm.eid}`, note: `ULN program ${SOLANA.uln}`, ixs: [ulnInit], cu: 400_000 },
    { kind: 'solana', title: `pin send and receive library to ULN 302 for eid ${evm.eid}`, note: `explicit library ${SOLANA.uln}, so a later change of the endpoint default cannot move this pathway`, ixs: pin, cu: 400_000 },
    { kind: 'solana', title: `executor, send ULN and receive ULN config for eid ${evm.eid}`, note: `executor ${SOLANA.executor} max message ${SOLANA.executorMaxMessageSize} B; required DVNs ${dvnIds.join(' + ')} (${solDvns.map((k) => k.toBase58()).join(', ')}); send confirmations ${recvConf} (Solana -> ${evm.name}); receive confirmations ${sendConf} (${evm.name} -> Solana)`, ixs: cfg, cu: 600_000 },
  ]
}

const SET_CONFIG = 'setConfig(address,address,(uint32,uint32,bytes)[])'
const ULN_T = '(uint64,uint8,uint8,uint8,address[],address[])'
function buildEvm(): EvmStep[] {
  const ulnEnc = (conf: number) => cast('abi-encode', `f(${ULN_T})`, `(${conf},${evmDvns.length},0,0,[${evmDvns.join(',')}],[])`)
  const exeEnc = cast('abi-encode', 'f((uint32,address))', `(${evm.executorMaxMessageSize},${evm.executor})`)
  const mk = (title: string, note: string, to: string, sig: string, args: string[]): EvmStep => ({ kind: 'evm', title, note, to, sig, args, data: castCalldata(sig, args) })
  return [
    mk(`vault setPeer(${SOLANA_EID}, Store PDA)`, `peer = tesoro_bridge Store PDA ${store.toBase58()}`, vault, 'setPeer(uint32,bytes32)', [String(SOLANA_EID), storeHex]),
    mk(`endpoint setSendLibrary(vault, ${SOLANA_EID}, SendUln302)`, `pins ${evm.sendUln302}`, evm.endpoint, 'setSendLibrary(address,uint32,address)', [vault, String(SOLANA_EID), evm.sendUln302]),
    mk(`endpoint setReceiveLibrary(vault, ${SOLANA_EID}, ReceiveUln302, grace 0)`, `pins ${evm.receiveUln302}`, evm.endpoint, 'setReceiveLibrary(address,uint32,address,uint256)', [vault, String(SOLANA_EID), evm.receiveUln302, '0']),
    mk(`endpoint setConfig on SendUln302: executor + send ULN`, `executor ${evm.executor} max ${evm.executorMaxMessageSize} B; DVNs ${dvnIds.join(' + ')}; confirmations ${sendConf} (${evm.name} -> Solana)`, evm.endpoint, SET_CONFIG, [vault, evm.sendUln302, `[(${SOLANA_EID},1,${exeEnc}),(${SOLANA_EID},2,${ulnEnc(sendConf)})]`]),
    mk(`endpoint setConfig on ReceiveUln302: receive ULN`, `DVNs ${dvnIds.join(' + ')}; confirmations ${recvConf} (Solana -> ${evm.name})`, evm.endpoint, SET_CONFIG, [vault, evm.receiveUln302, `[(${SOLANA_EID},2,${ulnEnc(recvConf)})]`]),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// Verify (read-only)
// ---------------------------------------------------------------------------------------------------------------------
const j = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
let failures = 0
function check(label: string, ok: boolean, got?: unknown) {
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (got ${JSON.stringify(got)})`}`)
}
const lc = (s: string) => s.toLowerCase()
const evmCall = (to: string, sig: string, ...a: string[]) => cast('call', to, sig, ...a, '--rpc-url', evmRpc).replace(/ \[[^\]]*\]$/gm, '')

function verifyEvm() {
  console.log(`\nVERIFY ${evm.name} (read-only, ${evmRpc})`)
  try {
    verifyEvmReads()
  } catch (e) {
    check('EVM reads', false, e instanceof Error ? e.message.split('\n')[0] : e)
  }
}

function verifyEvmReads() {
  const code = cast('code', vault, '--rpc-url', evmRpc)
  if (code === '0x') return check(`vault ${vault} has code`, false, 'no code (not deployed yet)')
  check('endpoint eid()', evmCall(evm.endpoint, 'eid()(uint32)') === String(evm.eid), evmCall(evm.endpoint, 'eid()(uint32)'))
  check('vault owner() = --safe', lc(evmCall(vault, 'owner()(address)')) === lc(safe), evmCall(vault, 'owner()(address)'))
  check('endpoint delegates(vault) = --safe', lc(evmCall(evm.endpoint, 'delegates(address)(address)', vault)) === lc(safe), evmCall(evm.endpoint, 'delegates(address)(address)', vault))
  check(`vault peers(${SOLANA_EID}) = Store PDA`, lc(evmCall(vault, 'peers(uint32)(bytes32)', String(SOLANA_EID))) === lc(storeHex), evmCall(vault, 'peers(uint32)(bytes32)', String(SOLANA_EID)))
  const sendLib = evmCall(evm.endpoint, 'getSendLibrary(address,uint32)(address)', vault, String(SOLANA_EID))
  check('send library pinned to SendUln302', lc(sendLib) === lc(evm.sendUln302) && evmCall(evm.endpoint, 'isDefaultSendLibrary(address,uint32)(bool)', vault, String(SOLANA_EID)) === 'false', sendLib)
  const [recvLib, isDefault] = evmCall(evm.endpoint, 'getReceiveLibrary(address,uint32)(address,bool)', vault, String(SOLANA_EID)).split('\n')
  check('receive library pinned to ReceiveUln302', lc(recvLib) === lc(evm.receiveUln302) && isDefault === 'false', [recvLib, isDefault])
  const cfg = (lib: string, type: number) => evmCall(evm.endpoint, 'getConfig(address,address,uint32,uint32)(bytes)', vault, lib, String(SOLANA_EID), String(type))
  const decode = (type: string, hex: string) => JSON.parse(cast('abi-decode', '--json', `f()(${type})`, hex))[0]
  const [maxSize, exeAddr] = decode('(uint32,address)', cfg(evm.sendUln302, 1))
  check(`executor ${evm.executor} max message ${evm.executorMaxMessageSize} B`, lc(exeAddr) === lc(evm.executor) && Number(maxSize) === evm.executorMaxMessageSize, [maxSize, exeAddr])
  for (const [name, lib, conf] of [['send ULN', evm.sendUln302, sendConf], ['receive ULN', evm.receiveUln302, recvConf]] as const) {
    const [confirmations, required, optional, threshold, dvns, optDvns] = decode(ULN_T, cfg(lib, 2))
    check(`${name}: confirmations ${conf}`, Number(confirmations) === conf, confirmations)
    check(`${name}: required DVNs ${dvnIds.join(' + ')}, none optional`, JSON.stringify((dvns as string[]).map(lc)) === JSON.stringify(evmDvns.map(lc)) && Number(required) === evmDvns.length && Number(optional) === 0 && Number(threshold) === 0 && optDvns.length === 0, { dvns, required, optional })
  }
  console.log(`  info solanaReceiveCu = ${evmCall(vault, 'solanaReceiveCu()(uint128)')} (EVM -> Solana lzReceive compute units)`)
}

async function verifySolana() {
  console.log(`\nVERIFY Solana (read-only, ${solRpc})`)
  const conn = new Connection(solRpc!, 'confirmed')
  check('cluster is mainnet-beta', (await conn.getGenesisHash()) === SOLANA_MAINNET_GENESIS)
  if (!(await conn.getAccountInfo(store))) return check(`Store ${store.toBase58()} exists`, false, 'tesoro_bridge not initialised on this cluster')
  const peer = await conn.getAccountInfo(peerPda)
  check(`PeerConfig ${peerPda.toBase58()} exists`, !!peer)
  if (peer) {
    const d = peer.data
    check('PeerConfig peer_address = vault', Buffer.compare(d.subarray(8, 40), vaultBytes32) === 0)
    check(`PeerConfig decimals ${decimals}, rate ${rateBps} bps`, d[40] === decimals && d.readUInt16LE(41) === rateBps, [d[40], d.readUInt16LE(41)])
    const len = d.readUInt32LE(43)
    check(`PeerConfig enforced send options = ${enforcedOptions.toString('hex')}`, Buffer.compare(d.subarray(47, 47 + len), enforcedOptions) === 0)
  }
  const lib = j(await endpoint.getSendLibrary(umi.rpc, oapp, evm.eid))
  check('send library resolves to ULN 302', JSON.stringify(lib).includes('7a4WjyR8') || !!lib, lib)
  const want = (conf: number) => ({ conf: String(conf), dvns: solDvns.map((k) => k.toBase58()) })
  for (const [name, state, conf] of [
    ['send ULN (Solana -> EVM)', await uln.getFinalSendConfigState(umi.rpc, oapp, evm.eid), recvConf],
    ['receive ULN (EVM -> Solana)', await uln.getFinalReceiveConfigState(umi.rpc, oapp, evm.eid), sendConf],
  ] as const) {
    const u = j((state as any)?.uln ?? state)
    const w = want(conf)
    check(`${name}: confirmations ${w.conf}`, u?.confirmations === w.conf, u?.confirmations)
    check(`${name}: DVN set ${dvnIds.join(' + ')}, none optional`, JSON.stringify([...(u?.requiredDvns ?? [])].sort()) === JSON.stringify([...w.dvns].sort()) && u?.requiredDvnCount === w.dvns.length && u?.optionalDvnCount === 0, u)
  }
  const sendState = j(await uln.getSendConfigState(umi.rpc, oapp, evm.eid))
  check(`executor ${SOLANA.executor}`, sendState?.executor?.executor === SOLANA.executor && sendState?.executor?.maxMessageSize === SOLANA.executorMaxMessageSize, sendState?.executor)
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const sol = await buildSolana()
  const evmSteps = buildEvm()
  console.log(execute ? 'MODE: EXECUTE (sends the Solana steps signed by --keypair; EVM steps are only printed)' : 'MODE: DRY RUN (nothing is sent; --execute would send the Solana steps)')
  console.log(`pathway   ${evm.name} (eid ${evm.eid}) <-> Solana mainnet (eid ${SOLANA_EID})`)
  console.log(`bridge    program ${programId.toBase58()}  Store PDA ${store.toBase58()}  (${storeHex})`)
  console.log(`vault     ${vault}   EVM owner + delegate (Safe) ${safe}   Solana delegate ${delegate.toBase58()}`)
  console.log(`DVNs      ${dvnIds.join(' + ')} (all required, none optional)   confirmations: ${evm.name}->Solana ${sendConf}, Solana->${evm.name} ${recvConf}`)
  console.log(`endpoints Solana ${EndpointProgram.ENDPOINT_PROGRAM_ID}   ${evm.name} ${evm.endpoint}\n`)

  console.log('== SOLANA (signed by the delegate key until set_admin moves it to the multisig)')
  sol.forEach((s, i) => {
    console.log(`S${i + 1}. ${s.title}\n    ${s.note}`)
    for (const ix of s.ixs) console.log(`    ix program ${ix.programId.toBase58()}  accounts ${ix.keys.length}  data ${ix.data.length} B 0x${ix.data.subarray(0, 24).toString('hex')}${ix.data.length > 24 ? '...' : ''}`)
  })
  console.log('\n== EVM (calls from the vault owner / delegate Safe; not sent by this script)')
  evmSteps.forEach((s, i) => console.log(`E${i + 1}. ${s.title}\n    ${s.note}\n    to ${s.to}\n    cast send ${s.to} "${s.sig}" ${s.args.map((a) => `"${a}"`).join(' ')} --rpc-url ${evmRpc}\n    calldata ${s.data.length > 200 ? s.data.slice(0, 200) + '...' : s.data}`))
  const safeFile = one('safe-json')
  if (safeFile) {
    writeFileSync(safeFile, JSON.stringify({ version: '1.0', chainId: String(evm.chainId), createdAt: 0, meta: { name: `Tesoro LayerZero wiring ${evm.name} <-> Solana` }, transactions: evmSteps.map((s) => ({ to: s.to, value: '0', data: s.data })) }, null, 2))
    console.log(`\nSafe Transaction Builder batch written to ${safeFile}`)
  }

  if (execute) {
    const rpc = need('rpc')
    const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need('keypair'), 'utf8'))))
    if (signer.publicKey.toBase58() === COMPROMISED) throw new Error('--keypair is the compromised key')
    if (!signer.publicKey.equals(delegate)) throw new Error(`--keypair is ${signer.publicKey.toBase58()}, not --delegate`)
    const conn = new Connection(rpc, 'confirmed')
    if ((await conn.getGenesisHash()) !== SOLANA_MAINNET_GENESIS) throw new Error('--rpc is not Solana mainnet-beta')
    for (const [i, s] of sol.entries()) {
      if (i === 0 && (await conn.getAccountInfo(store))) { console.log('S1 skipped: Store exists'); continue }
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: s.cu }), ...s.ixs)
      console.log(`S${i + 1}: ${await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' })}`)
    }
  } else {
    console.log('\nDry run only. Review every address against docs/cross-chain.md "Mainnet wiring", then run with --verify after the real run.')
  }

  if (verify) {
    if (solRpc) await verifySolana()
    else console.log('\n(Solana verify skipped: pass --rpc)')
    verifyEvm()
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
    process.exit(failures ? 1 : 0)
  }
}
main().catch((e) => { console.error(process.env.LZ_DEBUG && e instanceof Error ? e.stack : e instanceof Error ? e.message : e); process.exit(1) })
