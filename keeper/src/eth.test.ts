import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Budget } from "./act.ts";
import { NETS, reportStep, type EthIo, type EthTarget, type State } from "./eth.ts";

const GWEI = 1_000_000_000n;
const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;
const notFound = (name: string) => Object.assign(new Error(name), { name });

/** A Hoodi stand-in: the receipt shows up only once `mined` is set. */
function fakeIo() {
  const calls = { write: 0, receipt: 0 };
  let mined: "success" | "reverted" | null = null;
  let known = true;
  const io: EthIo = {
    account: { address: "0x0000000000000000000000000000000000000001" },
    pub: {
      readContract: async ({ functionName }: any) => (functionName === "getPosition" ? { unlocked: false, outSeq: 3n } : 1_000_000n * GWEI),
      getTransactionReceipt: async () => {
        calls.receipt++;
        if (!mined) throw notFound("TransactionReceiptNotFoundError");
        return { status: mined, gasUsed: 200_000n, effectiveGasPrice: 2n * GWEI };
      },
      getTransaction: async () => {
        if (!known) throw notFound("TransactionNotFoundError");
        return {};
      },
      getBalance: async () => 10n ** 18n,
      simulateContract: async () => ({ request: { to: "vault" } }),
      estimateContractGas: async () => 250_000n,
      getGasPrice: async () => 2n * GWEI,
    },
    wallet: {
      writeContract: async () => {
        calls.write++;
        return HASH;
      },
    },
  };
  return { io, calls, mine: (s: "success" | "reverted") => (mined = s), forget: () => (known = false) };
}

const settings = { ethYieldMins: 10, ethHourlyCapEth: 0.05, dryRun: false };
const target: EthTarget = { slot: "0xvault#7", vault: "0x0000000000000000000000000000000000000002", id: 7n, inSeq: 3n, subject: "t" };

describe("reportYield bookkeeping (OC-07)", () => {
  it("records state and spend at send, and never re-sends while the receipt is slow", async () => {
    const { io, calls, mine } = fakeIo();
    const budget = new Budget(50_000_000);
    const state: State = {};
    let saved = 0;
    const save = () => saved++;
    const t0 = Date.now();

    assert.equal(await reportStep(io, settings, budget, state, save, target, t0), "sent");
    assert.equal(calls.write, 1);
    assert.equal(calls.receipt, 0, "the send does not wait for its receipt");
    assert.equal(saved, 1);
    assert.deepEqual(state[target.slot], { sentAt: (state[target.slot] as any).sentAt, hash: HASH, estGwei: 1_000_000 + 500_000 });
    assert.equal(budget.spentLastHour(), 1_500_000, "LayerZero fee + estimated gas counted at send");

    // Two minutes later, no receipt yet: the old job timed out here and sent a second reportYield.
    assert.equal(await reportStep(io, settings, budget, state, save, target, t0 + 120_000), "wait");
    assert.equal(calls.write, 1);

    mine("success");
    assert.equal(await reportStep(io, settings, budget, state, save, target, t0 + 180_000), "skip");
    assert.equal(typeof state[target.slot], "number", "confirmed: the window starts from the send");
    assert.equal(calls.write, 1);
    assert.equal(await reportStep(io, settings, budget, state, save, target, t0 + 240_000), "wait", "inside the window");
    assert.equal(calls.write, 1);
  });

  it("sends again only once a send is dropped (no receipt, unknown to the node, 15 min on)", async () => {
    const { io, calls, forget } = fakeIo();
    const budget = new Budget(50_000_000);
    const state: State = { [target.slot]: { sentAt: Date.now() - 20 * 60_000, hash: HASH, estGwei: 1 } };
    assert.equal(await reportStep(io, settings, budget, state, () => {}, target), "wait", "still known to the node");
    forget();
    assert.equal(await reportStep(io, settings, budget, state, () => {}, target), "skip");
    assert.equal(state[target.slot], undefined);
    assert.equal(await reportStep(io, settings, budget, state, () => {}, target), "sent");
    assert.equal(calls.write, 1);
  });

  it("keeps a send pending when the receipt lookup itself fails", async () => {
    const { io, calls } = fakeIo();
    io.pub.getTransactionReceipt = async () => {
      throw new Error("The request took too long to respond.");
    };
    const state: State = { [target.slot]: { sentAt: Date.now() - 60 * 60_000, hash: HASH, estGwei: 1 } };
    assert.equal(await reportStep(io, settings, new Budget(1e9), state, () => {}, target), "wait");
    assert.equal(calls.write, 0);
  });
});

describe("EVM networks", () => {
  it("maps each Source chain to its LayerZero eid, chain id, native unit and own cap", () => {
    const s = { hoodiRpc: "h", hyperEvmRpc: "y", ethHourlyCapEth: 0.005, hypeHourlyCapHype: 0.03 } as Parameters<(typeof NETS)[number]["cap"]>[0];
    const byChain = Object.fromEntries(NETS.map((n) => [n.chain, n]));
    assert.deepEqual([byChain.ethereum.eid, byChain.ethereum.unit, byChain.ethereum.chainDef("h").id, byChain.ethereum.cap(s)], [40449, "ETH", 560048, 0.005]);
    assert.deepEqual([byChain.hyperEvm.eid, byChain.hyperEvm.unit, byChain.hyperEvm.chainDef("y").id, byChain.hyperEvm.cap(s)], [40362, "HYPE", 998, 0.03]);
    assert.equal(byChain.hyperEvm.rpc(s), "y");
  });
});
