import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { heldGemas, holdingOrigin } from "./account";
import { nativeCustodyPda } from "./chain/native";

const line = (amount: bigint, classId = 3) => ({ amount, classId });

describe("Account Gemas", () => {
  it("counts lines whose Source could not be read, so the total matches the stores", () => {
    expect(heldGemas({ holdings: [line(7208n)] as never, unread: [{ ...line(2640n), key: "k", source: PublicKey.default, why: "x" }] })).toBe(9848);
  });

  it("leaves fee-class lines out of the playable total", () => {
    expect(heldGemas({ holdings: [line(100n), line(30n, 1)] as never })).toBe(100);
  });

  it("names a Season prize line by its Season, not as another Player's Lock", () => {
    expect(holdingOrigin({ isOwn: false, sourceOwner: "", prize: { route: nativeCustodyPda(), season: 4 } })).toBe("Season 4 prize");
    expect(holdingOrigin({ isOwn: true, sourceOwner: "x" })).toBe("Your Lock");
  });
});
