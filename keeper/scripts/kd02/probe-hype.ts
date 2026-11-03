// kd-02 exploration: state of the live HyperEVM bridge Position that could be Unlocked, and the LayerZero quotes.
import { PublicKey } from "@solana/web3.js";
import { QA, conn, makeCtx, relayerKey, retry, simV0, withCu } from "./lib.ts";
import { corePositionPda, EID_HYPEREVM, coreSourcePda } from "../../src/lz.ts";
import { decodeCorePosition } from "../../src/position.ts";
import { supplySources, connReader } from "../../src/supply.ts";
import { pda } from "../../src/kit.ts";

const ctx = makeCtx(QA.qsA);
const pid = Uint8Array.from(Buffer.from("dd12e37a9c35137be8a4f871507986da4671b20b000000000000000300000000", "hex"));
const cpKey = corePositionPda(EID_HYPEREVM, pid);
const info = await retry(() => conn.getAccountInfo(cpKey));
const cp: any = decodeCorePosition(ctx.core as any, info!.data);
const ownerAccount = new PublicKey(Uint8Array.from(cp.inner.owner));
const acct: any = await (ctx.core as any).account.tesoroAccount.fetch(ownerAccount);
console.log("account fields", Object.keys(acct).join(","));
const owner = new PublicKey(acct.authority);
console.log("core position", cpKey.toBase58(), "owner", owner.toBase58(), "status", Object.keys(cp.inner.status)[0], "openAdvance", cp.inner.openAdvance, "advances", cp.inner.advances, "unlock fields", Object.keys(cp.inner).join(","));
const src = coreSourcePda(cpKey, 0);
const books = await supplySources(ctx.core, connReader(conn), [{ source: src, cut: false }]);
console.log("book metas", books.metas.length, "missing", books.missing.length);
const ix = await (ctx.core as any).methods.unlock().accountsPartial({ ownerAuthority: owner, ownerAccount, economy: pda("economy"), position: cpKey }).remainingAccounts([{ pubkey: src, isSigner: false, isWritable: true }, ...books.metas]).instruction();
const relayer = await relayerKey();
const sim = await simV0(relayer, withCu(600_000, ix));
console.log("unlock alone: bytes", sim.bytes, "err", JSON.stringify(sim.err), "units", sim.units);
console.log("fee payer", relayer.toBase58());
console.log(sim.logs.slice(-6).join("\n"));
