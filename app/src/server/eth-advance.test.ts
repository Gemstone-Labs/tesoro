import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import idl from "@/lib/chain/idl/tesoro_core.json";
import { basketPda, spillPda } from "@/lib/chain/basket";
import { advanceSetup } from "./eth-advance";

describe("ETH/HYPE Advance for a pre-economy Account", () => {
  const payer = Keypair.generate().publicKey, account = Keypair.generate().publicKey;
  it("creates both missing stores before take_advance credits Gemas", async () => {
    const asked: string[] = [];
    const setup = await advanceSetup({ getMultipleAccountsInfo: async (keys) => { asked.push(...keys.map((k) => k.toBase58())); return [null, null]; } }, payer, account);
    expect(asked).toEqual([basketPda(account).toBase58(), spillPda(account).toBase58()]);
    expect(setup).toHaveLength(1);
    const ix = setup[0];
    expect(new BorshInstructionCoder(idl as unknown as Idl).decode(ix.data)?.name).toBe("init_stores");
    expect(ix.keys[0]).toMatchObject({ pubkey: payer, isSigner: true, isWritable: true });
    expect(ix.keys[1].pubkey).toEqual(account);
  });
  it("leaves current Accounts alone", async () => {
    expect(await advanceSetup({ getMultipleAccountsInfo: async () => [{}, {}] }, payer, account)).toEqual([] as TransactionInstruction[]);
  });
  it("refuses a partial store pair instead of trying to overwrite an existing store", async () => {
    await expect(advanceSetup({ getMultipleAccountsInfo: async () => [{}, null] }, payer, account)).rejects.toThrow(/incomplete/);
  });
});
