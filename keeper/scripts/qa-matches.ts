// QA helper: newest tesoro_core Matches with status, entry and game (read-only).
import { settings } from "../src/env.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";
import { Keypair, PublicKey } from "@solana/web3.js";
const b58 = (x: any) => (x ? new PublicKey(Uint8Array.from(x)).toBase58().slice(0, 4) : "-");

const s = settings();
const conn = newConnection(s.rpc, s.gpaRpc);
const rt = buildRuntime(s, conn, Keypair.generate());
const rows: any[] = await rt.core.account.matchState.all();
rows.sort((a, b) => (BigInt(a.account.id.toString()) < BigInt(b.account.id.toString()) ? 1 : -1));
for (const m of rows.slice(0, Number(process.argv[2] ?? 8))) {
  const i = m.account.inner;
  console.log(m.account.id.toString(), Object.keys(i.status)[0], "entry", i.entry.toString(), "game", b58(i.game), "a", b58(i.a?.player), "b", b58(i.b?.player), m.publicKey.toBase58());
}
process.exit(0);
