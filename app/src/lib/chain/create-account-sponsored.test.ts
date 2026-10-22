import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { planTransaction } from "@/server/sponsor/rules";

const relayer = Keypair.generate().publicKey;
const state = vi.hoisted(() => ({ balance: 0, paused: false, sponsoredSend: vi.fn(async () => "sig") }));

vi.mock("./client", async () => {
  const provider = new AnchorProvider(new Connection("http://127.0.0.1:9"), { publicKey: Keypair.generate().publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t }, {});
  const core = new Program(coreIdl as Idl, provider);
  return { getChain: () => ({ core, base: { getBalance: async () => state.balance } }) };
});
vi.mock("./sponsor-client", async (orig) => ({
  ...(await orig<typeof import("./sponsor-client")>()),
  sponsorStatus: async () => ({ relayer: relayer.toBase58(), paused: state.paused, low: false }),
  sponsoredSend: state.sponsoredSend,
}));

import { accountReady, createAccountSponsored } from "./match-flow";
import { SponsorError } from "./sponsor-client";
import { MIN_SOL_LAMPORTS } from "./config";

const player = Keypair.generate().publicKey;
const signer = { publicKey: player, signSerialized: async (b: Uint8Array) => b } as never;
const getToken = async () => null;

describe("a new Account for a wallet with no SOL", () => {
  beforeEach(() => {
    state.balance = 0;
    state.paused = false;
    state.sponsoredSend.mockClear();
    state.sponsoredSend.mockImplementation(async () => "sig");
  });

  it("is created through the relayer, with the sponsor repaying it, as a shape the relayer accepts", async () => {
    expect(await createAccountSponsored(signer, getToken)).toBe(true);
    const [, , ixs] = state.sponsoredSend.mock.calls[0] as unknown as [unknown, unknown, { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; programId: PublicKey; data: Buffer }[]];
    expect(ixs).toHaveLength(1);
    const plan = planTransaction(ixs.map((i) => ({ programId: i.programId, keys: i.keys, data: i.data })), { relayer, player, isGame: () => false });
    expect(plan).toMatchObject({ names: ["create_account"], onboarding: true });
    expect(plan.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
  });

  it("is not sponsored when the wallet can pay, the server is paused, or it refuses", async () => {
    state.balance = MIN_SOL_LAMPORTS;
    expect(await createAccountSponsored(signer, getToken)).toBe(false);
    state.balance = 0;
    state.paused = true;
    expect(await createAccountSponsored(signer, getToken)).toBe(false);
    state.paused = false;
    state.sponsoredSend.mockRejectedValueOnce(new SponsorError("limit", "account-limit", 429));
    expect(await createAccountSponsored(signer, getToken)).toBe(false);
    expect(await createAccountSponsored({ publicKey: player } as never, getToken)).toBe(false);
  });

  it("an Account that exists is never created again", async () => {
    expect(await accountReady(signer, getToken, true)).toBe(true);
    expect(state.sponsoredSend).not.toHaveBeenCalled();
    expect(await accountReady(signer, getToken, false)).toBe(true);
    expect(state.sponsoredSend).toHaveBeenCalledTimes(1);
  });
});
