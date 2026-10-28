import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { planExit } from "./exit-route";
import { unlockStakeIx, JITOSOL } from "./stake";
import { initCkptPageIx } from "./redeem";
import { createAtaIdempotentIx } from "./stake-pool";
import { sourcePda } from "./native";

const player = Keypair.generate().publicKey;
const relayer = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const unlock = unlockStakeIx(player, position, null, JITOSOL);

describe("how an exit is sent", () => {
  it("is free and paid by the relayer when every instruction is a core one", () => {
    const r = planExit([unlock], player, relayer);
    expect(r.kind).toBe("free");
    expect(r.feePayer.equals(relayer)).toBe(true);
    expect(r.ixs).toEqual([unlock]);
  });
  it("lets the relayer pay the token account and checkpoint setup of a 0-SOL Player's Unlock", () => {
    const ata = createAtaIdempotentIx(player, player, JITOSOL.mint);
    const page = initCkptPageIx(player, sourcePda(position, 0), 3, 1);
    const r = planExit([page, ata, unlock], player, relayer);
    expect(r.kind).toBe("prepared");
    expect(r.feePayer.equals(relayer)).toBe(true);
    expect(r.ixs.slice(0, -1).every((ix) => ix.keys[0].pubkey.equals(relayer))).toBe(true);
    expect(r.ixs.at(-1)).toBe(unlock);
    expect(ata.keys[0].pubkey.equals(player)).toBe(true);
  });
  it("is self-pay, paid by the Player, for anything else", () => {
    const foreign = SystemProgram.transfer({ fromPubkey: player, toPubkey: relayer, lamports: 1 });
    const r = planExit([foreign, unlock], player, relayer);
    expect(r.kind).toBe("self-pay");
    expect(r.feePayer.equals(player)).toBe(true);
  });
  it("keeps a lone setup instruction self-pay: nothing to finish", () => {
    expect(planExit([createAtaIdempotentIx(player, player, JITOSOL.mint)], player, relayer).kind).toBe("self-pay");
  });
});
