import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { gemaTotals, heldGemas, holdingOrigin, unreadGemas, unreadNote } from "./account";
import { nativeCustodyPda } from "./chain/native";

const line = (amount: bigint, classId = 3) => ({ amount, classId });

describe("Account Gemas", () => {
  const snap = { holdings: [line(7208n)] as never, unread: [{ ...line(2581n), key: "k", source: PublicKey.default, why: "x" }, { ...line(9n, 1), key: "f", source: PublicKey.default, why: "x" }] };

  it("keeps lines whose Source could not be read out of the total, so pending and redeemable add up to it", () => {
    expect(heldGemas(snap)).toBe(7208);
    const g = gemaTotals({ total: heldGemas(snap), redeemable: 7000, reserved: 0, waiting: 0, unread: unreadGemas(snap) });
    expect(g.pending + 7000).toBe(g.total);
    expect(g.unread).toBe(2581);
  });

  it("counts unread Gemas on their own, fee classes left out", () => {
    expect(unreadGemas(snap)).toBe(2581);
    expect(unreadGemas({ unread: undefined })).toBe(0);
  });

  it("says plainly when some Gemas could not be read", () => {
    expect(unreadNote(2581)).toBe("2,581 Gemas couldn't be read right now. Try again later.");
    expect(unreadNote(1)).toBe("1 Gema couldn't be read right now. Try again later.");
  });

  it("leaves fee-class lines out of the playable total", () => {
    expect(heldGemas({ holdings: [line(100n), line(30n, 1)] as never })).toBe(100);
  });

  it("names a Season prize line by its Season, not as another Player's Lock", () => {
    expect(holdingOrigin({ isOwn: false, sourceOwner: "", prize: { route: nativeCustodyPda(), season: 4 } })).toBe("Season 4 prize");
    expect(holdingOrigin({ isOwn: true, sourceOwner: "x" })).toBe("Your Lock");
  });
});
