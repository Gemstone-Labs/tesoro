/**
 * Devnet check of the Delivery Fee on an EVM Unlock (keeper-diet tickets 14, 15): a fresh EVM key and the fresh Solana wallet
 * lock simETH/simHYPE in the V2 vault for 1 month (10 minutes at the devnet clock), then Unlock it through the app's own flow
 * (sponsor + LayerZero quote route) and read what the vault paid and what the Delivery Fee was. Keys live in KD20_EVM (scratch).
 *
 *   cd app && SPONSOR_ORIGIN=http://localhost:3022 ../keeper/node_modules/.bin/tsx scripts/kd20-eth.mts open  hyperevm|hoodi
 *   cd app && SPONSOR_ORIGIN=http://localhost:3022 ../keeper/node_modules/.bin/tsx scripts/kd20-eth.mts state hyperevm|hoodi <id>
 *   cd app && SPONSOR_ORIGIN=http://localhost:3022 ../keeper/node_modules/.bin/tsx scripts/kd20-eth.mts unlock hyperevm|hoodi <id>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3022";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;

const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const eth = await import("@/lib/chain/eth");
const flow = await import("@/lib/chain/eth-flow");
const { getChain } = await import("@/lib/chain/client");
const { PublicKey } = await import("@solana/web3.js");

const SOL_KEYS = join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json");
const EVM_KEY = process.env.KD20_EVM ?? join(homedir(), ".cache/tesoro-tmp/kd-20/evm-key.json");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(SOL_KEYS, "utf8"))[0]));
if (!existsSync(EVM_KEY)) writeFileSync(EVM_KEY, JSON.stringify({ key: generatePrivateKey() }), { mode: 0o600 });
const account = privateKeyToAccount(JSON.parse(readFileSync(EVM_KEY, "utf8")).key);
const signer = Object.assign(keypairSigner(kp), {
  async signSerialized(b: Uint8Array) {
    const t = VersionedTransaction.deserialize(b);
    t.sign([kp]);
    return t.serialize();
  },
});
const [cmd, netName = "hyperevm", idArg] = process.argv.slice(2);
const net = eth.NETS[netName as "hoodi" | "hyperevm"];
const vault = eth.ETH_VAULTS.find((v) => v.net === net.key && v.simulated)!;
const clientFor = (chain: typeof net.chain) => createWalletClient({ account, chain, transport: eth.evmTransport(net.rpc) });
const evm = { address: account.address, account, client: clientFor(net.chain), clientFor: () => clientFor(net.chain), prepare: async () => {}, source: "dev" as const };
const ctx = { signer: signer as never, evm: evm as never, getToken: async () => null };
const pub = createPublicClient({ chain: net.chain, transport: eth.evmTransport(net.rpc) });
const bal = async () => ({
  native: formatEther(await pub.getBalance({ address: account.address })),
  lst: formatEther((await pub.readContract({ address: vault.lst, abi: eth.lstAbi, functionName: "balanceOf", args: [account.address] })) as bigint),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log("evm", account.address, "solana", kp.publicKey.toBase58().slice(0, 6), "net", net.key, "vault", vault.address);

if (cmd === "open") {
  console.log("balances before", await bal());
  try {
    console.log("faucet simLST", await flow.getTestSimEth(ctx as never, vault));
  } catch (e) {
    console.log("faucet FAILED", String((e as Error).message ?? e).slice(0, 200));
  }
  await sleep(4000);
  console.log("balances", await bal());
  const opened = await flow.openEthPosition(ctx as never, vault, 100_000_000_000_000_000n, 1, (s) => console.log("  step", s));
  console.log("OPENED id", opened.id.toString(), "tx", opened.hash, "linkSig", opened.linkSig);
  writeFileSync(join(homedir(), `.cache/tesoro-tmp/kd-20/eth-${net.key}-id.txt`), opened.id.toString());
  process.exit(0);
}

const id = BigInt(idArg ?? readFileSync(join(homedir(), `.cache/tesoro-tmp/kd-20/eth-${net.key}-id.txt`), "utf8"));
if (cmd === "state") {
  const st = await eth.fetchEthState(getChain().base, vault.address, id, kp.publicKey);
  console.log(JSON.stringify(st, (_k, v) => (typeof v === "bigint" ? v.toString() : v?.toBase58 ? v.toBase58() : v), 1).slice(0, 2500));
  console.log("balances", await bal());
  process.exit(0);
}
if (cmd === "unlock") {
  const st = await eth.fetchEthState(getChain().base, vault.address, id, kp.publicKey);
  if (!st.core) console.log("apply_locked:", await flow.finishOpening(ctx as never, vault.address, id));
  const fresh = await eth.fetchEthState(getChain().base, vault.address, id, kp.publicKey);
  console.log("core", fresh.core && { status: fresh.core.status, openAdvance: fresh.core.openAdvance });
  const before = await bal();
  const sig = await flow.unlockEth(ctx as never, { vault: vault.address, id, position: new PublicKey(fresh.core!.address), openAdvance: fresh.core!.openAdvance });
  console.log("UNLOCK sig", sig);
  for (let i = 0; i < 60; i++) {
    await sleep(15_000);
    const now = await bal();
    console.log(i, "lst", now.lst, "native", now.native);
    if (now.lst !== before.lst) break;
  }
  process.exit(0);
}
