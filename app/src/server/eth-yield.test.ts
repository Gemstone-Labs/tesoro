import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ETH_VAULTS, BRIDGE_ID, ethPositionId, corePositionPda } from "@/lib/chain/eth";
import { sourcePda } from "@/lib/chain/native";
import { bookPda } from "@/lib/chain/basket";
import { applyYieldInstructions } from "./eth-yield";

describe("the app's reported-yield relay", () => {
  it("includes the open Advance's writable Source book in the CPI accounts", async () => {
    const vault = ETH_VAULTS.find((v) => v.net === "hyperevm")!.address;
    const pid = ethPositionId(vault, 1n);
    const source = sourcePda(corePositionPda(pid), 0);
    const read = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null) };
    const ixs = await applyYieldInstructions(read, PublicKey.default, vault, pid, 0);
    const ix = ixs.at(-1)!;
    expect(ix.programId.equals(BRIDGE_ID)).toBe(true);
    expect(ix.keys.find((k) => k.pubkey.equals(bookPda(source)))).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[6].pubkey.equals(source)).toBe(true);
  });
  it("uses the optional-account marker and no book after the Advance closes", async () => {
    const vault = ETH_VAULTS.find((v) => v.net === "hyperevm")!.address;
    const read = { getMultipleAccountsInfo: async () => { throw new Error("no open Source to read"); } };
    const ixs = await applyYieldInstructions(read, PublicKey.default, vault, ethPositionId(vault, 1n), null);
    expect(ixs.at(-1)!.keys[6]).toMatchObject({ pubkey: BRIDGE_ID, isWritable: false });
    expect(ixs.at(-1)!.keys).toHaveLength(8);
  });
});
