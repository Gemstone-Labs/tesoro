/** Prints how the server's LayerZero send quote lists the relayer and the payer flags (debug for the sponsor rules). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
const ORIGIN = process.env.SPONSOR_ORIGIN ?? "http://localhost:3022";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, i)) as typeof fetch;
const { keypairSigner } = await import("@/games/block-puzzle/live-chain");
const flow = await import("@/lib/chain/eth-flow");
const eth = await import("@/lib/chain/eth");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[0]));
const signer = Object.assign(keypairSigner(kp), { async signSerialized(b: Uint8Array) { const t = VersionedTransaction.deserialize(b); t.sign([kp]); return t.serialize(); } });
const vault = eth.ETH_VAULTS.find((v) => v.net === (process.argv[2] ?? "hyperevm") && v.simulated)!;
const q = await flow.ethCall<{ payer: string; send: { pubkey: string; signer: boolean; writable: boolean }[]; endpointSettings: string }>("send-quote", { signer: signer as never, getToken: async () => null }, { vault: vault.address, intent: "unlock" });
console.log("payer", q.payer, "count", q.send.length);
q.send.forEach((m, i) => { if (m.pubkey === q.payer || m.signer) console.log(i, m.pubkey.slice(0, 6), "signer", m.signer, "writable", m.writable); });
process.exit(0);
