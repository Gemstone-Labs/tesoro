import { Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { basketPda, decodeStore, spillPda, SIDE_WON } from "./basket";
import { coreIxName } from "./core-ix";
import { accountPda, nativeCustodyPda, simSolAta } from "./native";
import { redeemLineIxs } from "./redeem";

/**
 * The app-built `redeem_prize` against the deployed tesoro_core on devnet, by simulation only: nothing is signed or sent
 * (`sigVerify: false`), and the result is the post-state the program would write. Opt in with TESORO_DEVNET_SIM=1.
 * Holder: the Account of the November 25 QA (Season 4 prize line Cz9H…, 2,581 Gemas, native route).
 */
const RUN = process.env.TESORO_DEVNET_SIM === "1";
const RPC = process.env.TESORO_DEVNET_RPC ?? "https://rpc.magicblock.app/devnet";
const HOLDER = new PublicKey(process.env.TESORO_PRIZE_HOLDER ?? "AiXXAdUaZrDEo5FHyZzpmRwXT3q2GUwiPyY9SACQJTLQ");
const PRIZE = new PublicKey(process.env.TESORO_PRIZE_SOURCE ?? "Cz9HGbm6NATnvKSS7Kr6maMA8dakGKr6z8GEQReBDZzA");

vi.setConfig({ testTimeout: 120_000 });
const coder = new Program(coreIdl as Idl, {} as Provider).coder.accounts;
const tokenAmount = (data: Buffer | null) => (data ? data.readBigUInt64LE(64) : 0n);

describe.skipIf(!RUN)("redeem_prize on devnet (simulated)", () => {
  const conn = new Connection(RPC, "confirmed");
  const account = accountPda(HOLDER);
  const stores = [basketPda(account), spillPda(account)];
  const ata = simSolAta(HOLDER);

  const lineIn = (datas: (Buffer | null)[]) => {
    for (const d of datas) {
      const line = d ? decodeStore(d).lines.find((l) => l.source.equals(PRIZE) && l.side === SIDE_WON && l.dueAt === 0n) : undefined;
      if (line) return line.amount;
    }
    return 0n;
  };

  async function simulate(gemas: bigint) {
    const [prizeInfo, ...before] = await conn.getMultipleAccountsInfo([PRIZE, ...stores, ata]);
    const prize = coder.decode("prizeSourceState", prizeInfo!.data);
    const held = lineIn(before.slice(0, 2).map((i) => (i ? Buffer.from(i.data) : null)));
    const ixs = await redeemLineIxs(conn, HOLDER, { line: { side: SIDE_WON, dueAt: 0n, class: 3, tranche: 0 }, accounts: [], source: PRIZE, position: PublicKey.default, stakeMint: null, prize: { route: nativeCustodyPda(), season: prize.season } }, gemas);
    expect(coreIxName(ixs.at(-1)!)).toBe("redeem_prize");
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: HOLDER, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [...stores, ata].map((k) => k.toBase58()) } });
    const after = (sim.value.accounts ?? []).map((a) => (a ? Buffer.from(a.data[0], "base64") : null));
    return {
      err: sim.value.err,
      logs: sim.value.logs ?? [],
      held,
      left: lineIn(after.slice(0, 2)),
      paid: tokenAmount(after[2]) - tokenAmount(before[2] ? Buffer.from(before[2].data) : null),
      expectedShares: (gemas * BigInt(prize.inner.shares.toString())) / BigInt(prize.inner.gemas.toString()),
    };
  }

  it("redeems part of the prize line: the line drops by it and the holder's simSOL rises by its escrow shares", async () => {
    const r = await simulate(1000n);
    expect(r.err, r.logs.join("\n")).toBeNull();
    expect(r.held).toBeGreaterThanOrEqual(1000n);
    expect(r.left).toBe(r.held - 1000n);
    expect(r.paid).toBe(r.expectedShares);
    expect(r.logs.some((l) => l.includes("Instruction: RedeemPrize"))).toBe(true);
  });

  it("redeems the whole prize line", async () => {
    const [, ...stored] = await conn.getMultipleAccountsInfo([PRIZE, ...stores]);
    const all = lineIn(stored.map((i) => (i ? Buffer.from(i.data) : null)));
    const r = await simulate(all);
    expect(r.err, r.logs.join("\n")).toBeNull();
    expect(r.left).toBe(0n);
    expect(r.paid).toBe(r.expectedShares);
  });

  it("refuses more than the line holds", async () => {
    const [, ...stored] = await conn.getMultipleAccountsInfo([PRIZE, ...stores]);
    const r = await simulate(lineIn(stored.map((i) => (i ? Buffer.from(i.data) : null))) + 1n);
    expect(r.err).not.toBeNull();
  });
});
