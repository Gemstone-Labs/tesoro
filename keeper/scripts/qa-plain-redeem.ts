// QA (F-07): a plain `redeem` of an Ethereum-Sourced Holding must be refused on chain (only redeem_to_evm may pay it).
//   tsx scripts/qa-plain-redeem.ts <file with the holder's base58 dev key>
// Simulates (sends nothing) `redeem` for every Holding of the holder whose Source Position is not Solana-native.
import { readFileSync } from "node:fs";
import bs58 from "../../app/node_modules/bs58/src/cjs/index.cjs";
import anchor from "@coral-xyz/anchor";
const BN = (anchor as any).BN;
import { Keypair, PublicKey } from "@solana/web3.js";
import { settings } from "../src/env.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";
import { accountPda } from "../../app/src/lib/chain/native.ts";
import { simulateIxs } from "../src/tee.ts";

const holder = Keypair.fromSecretKey(((bs58 as any).default ?? bs58).decode(readFileSync(process.argv[2], "utf8").trim()));
const s = settings();
const conn = newConnection(s.rpc, s.gpaRpc);
const rt = buildRuntime(s, conn, holder);
const acct = accountPda(holder.publicKey);
const holdings: any[] = (await rt.core.account.holdingState.all()).filter((h: any) => h.account.account.equals(acct));
const sources: any[] = await rt.core.account.sourceState.all();
const positions: any[] = await rt.core.account.positionState.all();
const posByKey = new Map(positions.map((p) => [p.publicKey.toBase58(), p]));
for (const h of holdings) {
  const src = sources.find((x) => x.publicKey.equals(new PublicKey(Uint8Array.from(h.account.inner.source))));
  const pos = src && posByKey.get(new PublicKey(Uint8Array.from(src.account.inner.position)).toBase58());
  const chain = pos ? Object.keys(pos.account.inner.sourceChain)[0] : "?";
  console.log("holding", h.publicKey.toBase58().slice(0, 8), "source chain", chain, "amount", h.account.inner.amount?.toString());
  if (!pos || chain === "solana") continue;
  const ix = await rt.core.methods
    .redeem(new BN(1))
    .accountsPartial({ holderAuthority: holder.publicKey, holderAccount: acct, position: pos.publicKey, source: src.publicKey, holding: h.publicKey })
    .instruction();
  const res = await simulateIxs(conn, holder, [ix]);
  console.log("  plain redeem simulation:", res.err ? `REFUSED ${JSON.stringify(res.err)} ${(res.logs ?? []).filter((l) => /Error|error/.test(l)).slice(-1)[0] ?? ""}` : "SUCCEEDED (bug)");
}
process.exit(0);
