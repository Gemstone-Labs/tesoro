import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const state = { balance: 10n ** 18n };

vi.mock("./eth-fee", async (orig) => ({ ...(await orig<typeof import("./eth-fee")>()), playerPaysGas: () => true }));
vi.mock("./match-flow", () => ({ ensureReady: async () => {} }));
vi.mock("./client", () => ({ getChain: () => ({ base: {} }) }));
vi.mock("./eth", async (orig) => {
  const real = await orig<typeof import("./eth")>();
  return {
    ...real,
    coreAccountPda: () => ({}),
    fetchLinkState: async () => ({ linked: true, addressSet: true }),
    fetchEthMarket: async () => ({ simEth: 10n ** 18n, allowance: 0n, nextPositionId: 4n, quoteOpen: 10n ** 15n, ethBalance: state.balance }),
    evmClient: () => ({ getBalance: async () => state.balance, getGasPrice: async () => 20n * 10n ** 9n }),
  };
});
vi.mock("./signed-request", () => ({ newNonce: () => "n", signedMessage: () => "m" }));

import { ETH_VAULTS } from "./eth";
import { ensureGas, openEthPosition, requestGas, type EthCtx } from "./eth-flow";

const ctx = {
  signer: { publicKey: { toBase58: () => "me" }, signMessage: async () => new Uint8Array(64) },
  evm: { address: "0x" + "1".repeat(40), account: "0x" + "1".repeat(40), prepare: async () => {}, clientFor: () => ({ writeContract: async () => "0x" }) },
  getToken: async () => null,
} as unknown as EthCtx;

beforeEach(() => {
  calls.length = 0;
  state.balance = 10n ** 18n;
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    calls.push(`server:${JSON.parse(init.body).step}`);
    return { ok: true, json: async () => ({}) };
  });
});

describe("mainnet: the Player pays gas and the LayerZero fee", () => {
  it("never asks the relayer for a top-up", async () => {
    state.balance = 0n;
    await ensureGas(ctx, { key: "hoodi", native: "ETH" } as never);
    await expect(requestGas(ctx, { key: "hoodi", native: "ETH" } as never)).rejects.toThrow(/gas/);
    expect(calls).toEqual([]);
  });

  it("stops before any signature when the wallet cannot cover gas and the fee", async () => {
    state.balance = 1_000n;
    await expect(openEthPosition(ctx, ETH_VAULTS[0], 10n ** 17n, 12)).rejects.toThrow(/gas and the cross-chain fee/);
    expect(calls).toEqual([]);
  });

  it("HYPE: never asks the relayer for HYPE and says what to add", async () => {
    state.balance = 0n;
    const hype = { key: "hyperevm", native: "HYPE" } as never;
    await ensureGas(ctx, hype);
    await expect(requestGas(ctx, hype)).rejects.toThrow(/Add HYPE/);
    expect(calls).toEqual([]);
  });

  it("HYPE: stops before any signature when the wallet cannot cover gas and the fee", async () => {
    state.balance = 1_000n;
    const hypeVault = ETH_VAULTS.find((v) => v.net === "hyperevm")!;
    await expect(openEthPosition(ctx, hypeVault, 10n ** 17n, 12)).rejects.toThrow(/HYPE in your wallet for gas and the cross-chain fee/);
    expect(calls).toEqual([]);
  });
});
