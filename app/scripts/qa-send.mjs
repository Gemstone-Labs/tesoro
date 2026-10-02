/** Send native coin from a QA dev wallet. node scripts/qa-send.mjs <dev> <to> <amount> [hyperevm|hoodi] */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { createWalletClient, createPublicClient, http, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const [dev, to, amount, net = "hyperevm"] = process.argv.slice(2);
const keys = JSON.parse(readFileSync(`${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const rpc = net === "hyperevm" ? "https://rpc.hyperliquid-testnet.xyz/evm" : "https://ethereum-hoodi-rpc.publicnode.com";
const chain = { id: net === "hyperevm" ? 998 : 560048, name: net, nativeCurrency: { name: "n", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const w = createWalletClient({ account: privateKeyToAccount(keys[dev].evm), chain, transport: http(rpc, { timeout: 40000 }) });
const pc = createPublicClient({ chain, transport: http(rpc, { timeout: 40000 }) });
const hash = await w.sendTransaction({ to, value: parseEther(amount) });
await pc.waitForTransactionReceipt({ hash });
console.log("sent", hash);
