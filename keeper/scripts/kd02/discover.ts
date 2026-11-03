// kd-02 discovery: lists the live devnet subjects the measurements use (bridge Positions, Claims, ALT, Store).
// Usage: pnpm --filter @tesoro/keeper exec tsx scripts/kd02/discover.ts
// Reads only. GPA_RPC defaults to public devnet (magicblock's RPC hangs on getProgramAccounts).
import { Connection, PublicKey } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { BRIDGE, STORE, corePositionPda } from "../../src/lz.ts";
import { readBridgePosition } from "../../src/bridge.ts";
import { bridgeDisc, decodeClaim } from "../../src/bridge-ix.ts";

const RPC = process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";
const GPA = process.env.GPA_RPC ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const gpa = new Connection(GPA, "confirmed");

async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

const store = await retry(() => conn.getAccountInfo(STORE));
if (!store) throw new Error("no Store");
console.log("store bytes", store.data.length, "owner", store.owner.toBase58());
// Store layout: see bridge/programs/tesoro_bridge/src/state/store.rs
console.log("store hex", Buffer.from(store.data).toString("hex"));

const positions = await retry(() => gpa.getProgramAccounts(BRIDGE, { filters: [{ dataSize: 8 + 164 + 16 + 16 + 8 }] }));
console.log("bridge positions", positions.length);
for (const a of positions) {
  const p = readBridgePosition(a.pubkey, a.account.data);
  const cp = await retry(() => conn.getAccountInfo(corePositionPda(p.eid, p.positionId)));
  console.log(JSON.stringify({ key: p.key.toBase58(), eid: p.eid, pid: Buffer.from(p.positionId).toString("hex"), opened: p.opened, unlockSent: p.unlockSent, lastYieldSeq: String(p.lastYieldSeq), applied: String(p.appliedYieldSeq), core: cp ? cp.data.length : null }));
}
for (const [name, d] of [["claim", bridgeDisc.claim], ["instant", bridgeDisc.instantClaim]] as const) {
  const rows = await retry(() => gpa.getProgramAccounts(BRIDGE, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(d) } }] }));
  for (const a of rows) {
    const c = decodeClaim(a.pubkey, Buffer.from(a.account.data));
    console.log(name, c.address.toBase58(), "holder", c.holderAccount.toBase58(), "pos", c.position.toBase58(), "total", String(c.unitsTotal), "sent", String(c.unitsSent));
  }
}
