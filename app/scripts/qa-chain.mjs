/** Read-only HyperEVM / Hoodi helpers for QA.  node scripts/qa-chain.mjs lz <evm-address> [hyperevm|hoodi]
 *  Lists the vault's PositionLocked / YieldPaid logs for an owner and the LayerZero Scan status + timings. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPublicClient, http, parseAbi, getAddress } = require("viem");
import { readFileSync } from "node:fs";
const [cmd, who, net = "hyperevm"] = process.argv.slice(2);
const keys = JSON.parse(readFileSync(process.env.QA_KEYS ?? `${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const { privateKeyToAccount } = require("viem/accounts");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
// `who` is an EVM address or a dev name from the key file (keys are never printed).
const addr = keys[who] ? privateKeyToAccount(keys[who].evm).address : who;
if (cmd === "addr") {
  for (const d of who === "all" ? Object.keys(keys) : [who]) { const { PublicKey } = require("@solana/web3.js"); const w = Keypair.fromSecretKey(bs58.decode(keys[d].sol)).publicKey; const acct = PublicKey.findProgramAddressSync([Buffer.from("account"), w.toBuffer()], new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"))[0]; console.log(d, privateKeyToAccount(keys[d].evm).address, w.toBase58(), "account", acct.toBase58()); }
  process.exit(0);
}
const N = { hyperevm: { rpc: "https://rpc.hyperliquid-testnet.xyz/evm", vault: "0x23B17A4c55867406E7CD5602c664E1447400c4a3" }, hoodi: { rpc: "https://ethereum-hoodi-rpc.publicnode.com", vault: "0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a" } }[net];
if (cmd === "bal") {
  // qa-chain.mjs bal <dev|addr> [net] [positionId]: native balance, simLST balance and (optionally) vault position state.
  const vaultAbi = parseAbi(["function lst() view returns (address)", "function getPosition(uint64) view returns ((address owner, uint256 principalShares, uint256 principalUnderlying, uint256 openRate, uint256 heldShares, uint256 paidUnderlying, uint256 frozenAccrued, uint64 openTime, uint64 outSeq, uint64 inSeq, uint8 horizonMonths, bool unlocked))"]);
  const bc = createPublicClient({ transport: http(N.rpc, { timeout: 40000 }) });
  const lst = await bc.readContract({ address: N.vault, abi: vaultAbi, functionName: "lst" });
  const [native, sim] = await Promise.all([bc.getBalance({ address: addr }), bc.readContract({ address: lst, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [addr] })]);
  console.log(addr, "native", Number(native) / 1e18, "simLST", Number(sim) / 1e18);
  if (process.argv[5]) { const p = await bc.readContract({ address: N.vault, abi: vaultAbi, functionName: "getPosition", args: [BigInt(process.argv[5])] }); console.log("position", process.argv[5], "unlocked", p.unlocked, "principalUnderlying", Number(p.principalUnderlying) / 1e18, "paidUnderlying", Number(p.paidUnderlying) / 1e18, "inSeq", p.inSeq, "outSeq", p.outSeq); }
  process.exit(0);
}
if (cmd === "scan") {
  const r = await fetch(`https://scan-testnet.layerzero-api.com/v1/messages/wallet/${addr}?limit=${process.env.LIMIT ?? 10}`).then((x) => x.json());
  for (const m of r.data ?? []) {
    const s = m.source.tx?.blockTimestamp, d = m.destination?.tx?.blockTimestamp;
    console.log(m.status.name, `${m.pathway.srcEid}->${m.pathway.dstEid}`, new Date(s * 1000).toISOString().slice(11, 19), d ? `${d - s}s` : "inflight", "src", (m.source.tx?.txHash ?? "").slice(0, process.env.FULL ? 200 : 14), "dst", (m.destination?.tx?.txHash ?? "").slice(0, process.env.FULL ? 200 : 14));
  }
  process.exit(0);
}
const c = createPublicClient({ transport: http(N.rpc, { timeout: 40000 }) });
const ev = parseAbi(["event PositionLocked(uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq)"]);
const head = await c.getBlockNumber();
const logs = await c.getLogs({ address: N.vault, event: ev[0], args: { owner: getAddress(addr) }, fromBlock: head - BigInt(process.env.BACK ?? 990), toBlock: head });
for (const l of logs) {
  const blk = await c.getBlock({ blockNumber: l.blockNumber });
  console.log("PositionLocked id", l.args.positionId, "tx", l.transactionHash, "block time", new Date(Number(blk.timestamp) * 1000).toISOString());
  const r = await fetch(`https://scan-testnet.layerzero-api.com/v1/messages/tx/${l.transactionHash}`).then((x) => x.json()).catch(() => null);
  const m = r?.data?.[0];
  if (m) console.log("  scan:", m.status?.name, "src", m.source?.tx?.blockTimestamp, "dst", m.destination?.tx?.blockTimestamp, "->", m.destination?.tx?.txHash?.slice(0, 20), m.destination?.tx?.blockTimestamp && m.source?.tx?.blockTimestamp ? `${m.destination.tx.blockTimestamp - m.source.tx.blockTimestamp}s` : "");
}
