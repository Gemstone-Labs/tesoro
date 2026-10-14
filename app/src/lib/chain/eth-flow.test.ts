import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const calls: string[] = [];
const state = { allowance: 0n, resolveReceipt: () => {} };

vi.mock("./match-flow", () => ({ ensureReady: async () => {} }));
vi.mock("./client", () => ({ getChain: () => ({ base: {} }) }));
vi.mock("./eth", async (orig) => {
  const real = await orig<typeof import("./eth")>();
  return {
    ...real,
    coreAccountPda: () => ({}),
    fetchLinkState: async () => ({ linked: true, addressSet: true }),
    fetchEthMarket: async () => ({ simEth: 10n ** 18n, allowance: state.allowance, nextPositionId: 4n, quoteOpen: 1n, ethBalance: 10n ** 18n }),
    evmClient: () => ({
      getBalance: async () => 10n ** 18n,
      waitForTransactionReceipt: async () => {
        calls.push("receipt");
        await new Promise<void>((r) => (state.resolveReceipt = r));
        return { status: "success", logs: [] };
      },
    }),
  };
});
vi.mock("./signed-request", () => ({ newNonce: () => "n", signedMessage: () => "m" }));

import { ETH_VAULTS } from "./eth";
import { ethError, getTestSimEth, openEthPosition, type EthCtx } from "./eth-flow";

function ctx(): EthCtx {
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    calls.push(`wallet:${functionName}`);
    return "0xhash" as Hex;
  });
  return {
    signer: { publicKey: { toBase58: () => "me" }, signMessage: async () => new Uint8Array(64) },
    evm: { address: "0x" + "1".repeat(40), account: "0x" + "1".repeat(40), prepare: async () => {}, clientFor: () => ({ writeContract }) },
    getToken: async () => null,
  } as unknown as EthCtx;
}

beforeEach(() => {
  calls.length = 0;
  state.allowance = 0n;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    calls.push(`server:${JSON.parse(init.body).step}`);
    return { ok: true, json: async () => ({ hash: "0xfaucet" }) };
  });
});

describe("openEthPosition ordering", () => {
  it("asks the server to prepare the Position before the approval confirms", async () => {
    const done = openEthPosition(ctx(), ETH_VAULTS[0], 10n ** 17n, 1).catch(() => {});
    await vi.waitFor(() => expect(calls).toContain("server:init-position"));
    await vi.waitFor(() => expect(calls).toContain("receipt"));
    expect(calls).not.toContain("wallet:openPosition");
    state.resolveReceipt();
    await vi.waitFor(() => expect(calls).toContain("wallet:openPosition"));
    await vi.waitFor(() => expect(calls.filter((c) => c === "receipt")).toHaveLength(2));
    state.resolveReceipt();
    await done;
  });

  it("skips the approval when the allowance already covers the amount", async () => {
    state.allowance = 10n ** 18n;
    const done = openEthPosition(ctx(), ETH_VAULTS[0], 10n ** 17n, 1).catch(() => {});
    await vi.waitFor(() => expect(calls).toContain("wallet:openPosition"));
    expect(calls).not.toContain("wallet:approve");
    state.resolveReceipt();
    await done;
  });
});

describe("getTestSimEth", () => {
  it("is a server call: the wallet signs no transaction", async () => {
    expect(await getTestSimEth(ctx(), ETH_VAULTS[0])).toBe("0xfaucet");
    expect(calls).toEqual(["server:faucet-lst"]);
  });
});

describe("ethError", () => {
  it("turns public-RPC rate limits and timeouts into a plain retry message", () => {
    const busy = "The network is busy right now. Wait a few seconds and try again.";
    expect(ethError(Object.assign(new Error("x"), { shortMessage: "Request exceeds defined limit." }))).toBe(busy);
    expect(ethError(new Error("The request took too long to respond."))).toBe(busy);
    expect(ethError(new Error("HTTP request failed: rate limited"))).toBe(busy);
    expect(ethError(new Error("An unknown RPC error occurred."))).toBe(busy);
  });
  it("keeps other messages", () => {
    expect(ethError(Object.assign(new Error("x"), { shortMessage: "Execution reverted" }))).toBe("Execution reverted");
  });
});
