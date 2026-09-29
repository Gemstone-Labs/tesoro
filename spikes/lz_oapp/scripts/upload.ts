// Paced, resumable buffer upload for congested public devnet RPCs (the CLI aborts on the first 429).
// Usage: ts-node-transpile-only scripts/upload.ts <program.so> <buffer-keypair.json>
// The buffer must already exist (created by `solana program write-buffer --buffer <keypair>`) with the
// payer as authority. Afterwards: `solana program deploy --buffer <pubkey> --program-id <keypair>`.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const RPCS = (
    process.env.RPCS ??
    'https://api.devnet.solana.com,https://solana-devnet.api.onfinality.io/public,https://solana-devnet.gateway.tatum.io'
).split(',')
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const CHUNK = 900
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace('~', homedir()), 'utf8'))))

async function main() {
    const [soPath, bufPath] = process.argv.slice(2)
    const so = readFileSync(soPath)
    const payer = key(process.env.SOLANA_KEYPAIR ?? '~/.config/solana/id.json')
    const buffer = key(bufPath).publicKey
    const conns = RPCS.map((u) => new Connection(u, 'confirmed'))
    let ci = 0
    const call = async <T>(f: (c: Connection) => Promise<T>): Promise<T> => {
        for (let a = 0; ; a++) {
            try {
                return await f(conns[ci % conns.length])
            } catch {
                ci++
                await sleep(Math.min(1000 * (a + 1), 8000))
            }
        }
    }
    for (let round = 0; round < 50; round++) {
        const info = await call((c) => c.getAccountInfo(buffer))
        const cur = info!.data.subarray(37)
        const missing: number[] = []
        for (let off = 0; off < so.length; off += CHUNK) {
            if (!cur.subarray(off, off + CHUNK).equals(so.subarray(off, off + CHUNK))) missing.push(off)
        }
        console.log(`round ${round}: ${missing.length} chunks missing`)
        if (!missing.length) return
        for (let i = 0; i < missing.length; i += 12) {
            const batch = missing.slice(i, i + 12)
            const { blockhash } = await call((c) => c.getLatestBlockhash('confirmed'))
            for (const off of batch) {
                const bytes = so.subarray(off, off + CHUNK)
                const data = Buffer.alloc(16 + bytes.length)
                data.writeUInt32LE(1, 0) // UpgradeableLoaderInstruction::Write
                data.writeUInt32LE(off, 4)
                data.writeBigUInt64LE(BigInt(bytes.length), 8)
                bytes.copy(data, 16)
                const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
                    new TransactionInstruction({
                        programId: LOADER,
                        keys: [
                            { pubkey: buffer, isSigner: false, isWritable: true },
                            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
                        ],
                        data,
                    })
                )
                tx.sign(payer)
                await call((c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }))
                await sleep(250)
            }
            await sleep(1500)
        }
    }
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
