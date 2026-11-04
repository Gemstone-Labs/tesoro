// kd-02 bridge measurements: LayerZero quotes, send-account lists vs the lookup tables, bundle sizes, in-situ CU of send_pay_yield.
//   tsx scripts/kd02/bridge.ts           (reads devnet and simulates; sends nothing)
import { writeFileSync } from "node:fs";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  BRIDGE, ENDPOINT_SETTINGS, EID_HOODI, EID_HYPEREVM, STORE, AUTHORITY, CORE, bridgePositionPda, corePositionPda, coreSourcePda, disc, evmLinkPda, meta, peerPda, quoteFee, sendAccounts, sendParams, sourceAuthPda,
} from "../../src/lz.ts";
import { claimPda } from "../../src/bridge-ix.ts";
import { bookOf, ckptOf, pda, basketOf, spillOf } from "../../src/kit.ts";
import { QA, conn, makeCtx, measureBundle, retry, simV0, toReport, saveReports, withCu, loadAlt, legacyBytes, shapeOf, type BundleReport } from "./lib.ts";
import { u64le } from "../../src/kit.ts";
import { MSG } from "../../src/msg-types.ts";

const SPONSOR_ALT = new PublicKey("HcQqickLYCgnPkkmWZgHFjq5sThNeow19WnLZDwKF3KZ");
const vaults = [
  { name: "Hoodi (ETH)", eid: EID_HOODI, vault: "7a996874b9ffc35cc36bf154d02a23d16863a087", chain: "ethereum" },
  { name: "HyperEVM testnet (HYPE)", eid: EID_HYPEREVM, vault: "dd12e37a9c35137be8a4f871507986da4671b20b", chain: "hyperEvm" },
];
const pidOf = (vault: string, n: number) => {
  const b = Buffer.alloc(32);
  Buffer.from(vault, "hex").copy(b, 0);
  b.writeBigUInt64BE(BigInt(n), 20);
  return Uint8Array.from(b);
};

const ctx = makeCtx(QA.qeF);
const alt = await loadAlt(SPONSOR_ALT);
const altSet = new Set(alt.state.addresses.map((a) => a.toBase58()));
const reports: BundleReport[] = [];
const lists: Record<string, { quote: string[]; send: string[] }> = {};

console.log("## LayerZero quotes (lamports, SOL), quote_send simulated on devnet");
for (const v of vaults) {
  const pid = pidOf(v.vault, 1);
  const acc = await sendAccounts(ctx, v.eid, pid);
  lists[v.name] = { quote: acc.quote.map((m) => m.pubkey.toBase58()), send: acc.send.map((m) => m.pubkey.toBase58()) };
  for (const [type, label] of [[MSG.UNLOCK, "Unlock"], [MSG.PAY_YIELD, "PayYield"], [MSG.PAY_INSTANT, "PayInstant"]] as const) {
    const fees: bigint[] = [];
    for (let i = 0; i < 3; i++) fees.push(await retry(() => quoteFee(ctx, v.eid, pid, type, acc.quote)));
    console.log(JSON.stringify({ vault: v.name, eid: v.eid, message: label, lamports: fees.map(String), sol: fees.map((f) => Number(f) / 1e9) }));
  }
}

console.log("\n## send account lists");
const a = lists[vaults[0].name].send;
const b = lists[vaults[1].name].send;
console.log(JSON.stringify({ hoodiSendAccounts: a.length, hyperEvmSendAccounts: b.length, shared: a.filter((k) => b.includes(k)).length, hoodiOnly: a.filter((k) => !b.includes(k)), hyperOnly: b.filter((k) => !a.includes(k)) }));
for (const v of vaults) {
  const l = lists[v.name].send;
  const inAlt = l.filter((k) => altSet.has(k));
  console.log(JSON.stringify({ vault: v.name, sendAccounts: l.length, inSponsorAlt: inAlt.length, missing: l.filter((k) => !altSet.has(k)) }));
}
const lz = await retry(() => conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("LzReceiveTypes"), STORE.toBuffer()], BRIDGE)[0]));
console.log(JSON.stringify({ bridgeLzReceiveTypesPda: "H4ynhvzXRWAc13TmqxD48gN2at4UP61ui3vXkU6Si9ya", altField: new PublicKey(lz!.data.subarray(40, 72)).toBase58(), note: "all zero = no lookup table registered" }));

console.log("\n## bundle sizes (built with the keeper/app account lists; accounts need not exist to be sized)");
for (const v of vaults) {
  const pid = pidOf(v.vault, 1);
  const eid = v.eid;
  const owner = QA.qeF; // stands in for a Player who signs and pays
  const cpKey = corePositionPda(eid, pid);
  const ownerAccount = pda("account", owner.toBuffer());
  const source = coreSourcePda(cpKey, 0);
  const pages = [ckptOf(source, 1, 0)];
  const book = bookOf(source);
  const acc = await sendAccounts(ctx, eid, pid);
  // Independent of the Player and the Position: the bridge's own accounts, the LayerZero list of this vault's pathway and this vault's peer.
  const stable = [STORE, AUTHORITY, ENDPOINT_SETTINGS, peerPda(eid, pid), sourceAuthPda(eid), pda("economy"), ...acc.send.map((m) => m.pubkey)];

  const unlock = await (ctx.core as any).methods
    .unlock()
    .accountsPartial({ ownerAuthority: owner, ownerAccount, economy: pda("economy"), position: cpKey })
    .remainingAccounts([source, book, ...pages].map((k) => ({ pubkey: k, isSigner: false, isWritable: true })))
    .instruction();
  const fee = await retry(() => quoteFee(ctx, eid, pid, MSG.UNLOCK, acc.quote));
  const sendUnlock = new TransactionInstruction({
    programId: BRIDGE,
    keys: [meta(owner, true, true), meta(peerPda(eid, pid)), meta(STORE), meta(bridgePositionPda(eid, pid), false, true), meta(cpKey), meta(ENDPOINT_SETTINGS), meta(SystemProgram.programId), ...acc.send],
    data: Buffer.concat([disc("send_unlock"), sendParams(eid, pid, fee)]),
  });
  await measureBundle(`unlock+send_unlock ${v.name}`, owner, withCu(600_000, unlock, sendUnlock), { stable });
  await measureBundle(`send_unlock alone ${v.name}`, owner, withCu(400_000, sendUnlock));
  reports.push(toReport(`unlock+send_unlock ${v.name}`, owner, withCu(600_000, unlock, sendUnlock)));

  // redeem_to_evm + send_pay_yield
  const holderAccount = ownerAccount;
  const claim = claimPda(holderAccount, source);
  const redeem = new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      meta(owner, true, true), meta(STORE), meta(AUTHORITY), meta(sourceAuthPda(eid)), meta(holderAccount, false, true), meta(cpKey, false, true), meta(source, false, true), meta(basketOf(holderAccount), false, true),
      meta(spillOf(holderAccount), false, true), meta(claim, false, true), meta(CORE), meta(SystemProgram.programId), ...[book, ...pages].map((k) => meta(k, false, true)),
    ],
    data: Buffer.concat([disc("redeem_to_evm"), Buffer.alloc(11), u64le(1_000n)]),
  });
  const feeY = await retry(() => quoteFee(ctx, eid, pid, MSG.PAY_YIELD, acc.quote));
  const sendPay = new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      meta(owner, true, true), meta(peerPda(eid, pid)), meta(STORE), meta(bridgePositionPda(eid, pid), false, true), meta(cpKey), meta(holderAccount), meta(evmLinkPda(Buffer.alloc(20, 7))), meta(claim, false, true),
      meta(ENDPOINT_SETTINGS), meta(SystemProgram.programId), ...acc.send,
    ],
    data: Buffer.concat([disc("send_pay_yield"), sendParams(eid, pid, feeY)]),
  });
  await measureBundle(`redeem_to_evm+send_pay_yield ${v.name}`, owner, withCu(600_000, redeem, sendPay), { stable });
  await measureBundle(`send_pay_yield alone ${v.name}`, owner, withCu(400_000, sendPay));
  reports.push(toReport(`redeem_to_evm+send_pay_yield ${v.name}`, owner, withCu(600_000, redeem, sendPay)));
}

console.log("\n## in-situ CU: send_pay_yield on the live pending Claim 3Qop34c1 (HyperEVM, units_sent 0), simulated");
{
  const eid = EID_HYPEREVM;
  const pid = pidOf(vaults[1].vault, 1);
  const claimKey = new PublicKey("3Qop34c1q5RBJ1dRJuzQhq3DWBPWaJCPG6zRrSrBytr9");
  const holder = new PublicKey("71hCesb8eED3yoFjgxDG8fSfqgZV4Ngfnr2sX3jHL5Yg");
  const holderAcct: any = await (ctx.core as any).account.tesoroAccount.fetch(holder);
  const acc = await sendAccounts(ctx, eid, pid);
  const fee = await quoteFee(ctx, eid, pid, MSG.PAY_YIELD, acc.quote);
  const ix = new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      meta(QA.qsA, true, true), meta(peerPda(eid, pid)), meta(STORE), meta(bridgePositionPda(eid, pid), false, true), meta(corePositionPda(eid, pid)), meta(holder), meta(evmLinkPda(Uint8Array.from(holderAcct.evmAddress))),
      meta(claimKey, false, true), meta(ENDPOINT_SETTINGS), meta(SystemProgram.programId), ...acc.send,
    ],
    data: Buffer.concat([disc("send_pay_yield"), sendParams(eid, pid, fee)]),
  });
  const sim = await simV0(QA.qsA, withCu(400_000, ix));
  console.log(JSON.stringify({ bytes: sim.bytes, err: sim.err, units: sim.units, feeLamports: String(fee) }));
  console.log(sim.logs.filter((l) => /consumed|Error|failed/.test(l)).slice(-6).join("\n"));
}
saveReports(process.env.KD_OUT ?? "/tmp/kd02-bridge-bundles.json", reports);
