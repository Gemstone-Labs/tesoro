import { describe, expect, it } from "vitest";
import { checkApplication } from "./apply";
import { codeHash } from "./hash";
import { isFeaturedNow, listingStage, type ChainListing, type LiveProgram, type PaperState } from "./state";

const GOOD = { programId: "TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH", studio: "Moss Labs", gameName: "Word Duel", contactEmail: "hi@moss.example", site: "https://moss.example", blurb: "Two players race to spell." };

describe("the apply form", () => {
  it("accepts a complete application and trims it", () => {
    const r = checkApplication({ ...GOOD, studio: "  Moss Labs " });
    expect(r).toEqual({ ok: true, value: GOOD });
  });
  it.each([
    [{ studio: "" }, "Studio name"],
    [{ gameName: "x".repeat(61) }, "Game"],
    [{ programId: "not-an-address!" }, "program address"],
    [{ contactEmail: "nope" }, "email"],
    [{ site: "javascript:alert(1)" }, "https://"],
    [{ blurb: "x".repeat(601) }, "600"],
  ])("refuses %j", (patch, text) => {
    const r = checkApplication({ ...GOOD, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(text);
  });
  it("lets the website and description stay empty", () => {
    expect(checkApplication({ ...GOOD, site: "", blurb: "" }).ok).toBe(true);
  });
  it("refuses a non-object body", () => {
    expect(checkApplication(null).ok).toBe(false);
  });
});

describe("codeHash", () => {
  it("ignores the header and trailing zeros (an ExtendProgram only appends zeros)", async () => {
    const code = [1, 2, 3, 4];
    const a = new Uint8Array([...new Array(45).fill(9), ...code]);
    const b = new Uint8Array([...new Array(45).fill(7), ...code, 0, 0, 0, 0]);
    expect(await codeHash(a)).toBe(await codeHash(b));
    expect(await codeHash(new Uint8Array([...new Array(45).fill(9), 1, 2, 3, 5]))).not.toBe(await codeHash(a));
  });
  it("matches SHA-256 of the code", async () => {
    const data = new Uint8Array([...new Array(45).fill(0), ...new TextEncoder().encode("abc")]);
    expect(await codeHash(data)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("listingStage: apply -> accept -> list -> upgrade -> unlist -> re-approve", () => {
  const NOW = 1_000_000;
  const YEAR = 365 * 86_400;
  const accepted: PaperState = { status: "accepted", paidUntil: null };
  const paid: PaperState = { status: "accepted", paidUntil: NOW + YEAR };
  const listed: ChainListing = { listedUntil: NOW + YEAR, approvedSlot: 50n, approvedHash: "aa" };
  const live = (slot: bigint, hash: string): LiveProgram => ({ slot, hash });

  it("walks the whole life", () => {
    expect(listingStage({ status: "applied", paidUntil: null }, null, null, NOW)).toBe("applied");
    expect(listingStage({ status: "rejected", paidUntil: null }, null, null, NOW)).toBe("rejected");
    expect(listingStage(accepted, null, null, NOW)).toBe("awaiting-payment");
    expect(listingStage(paid, null, live(50n, "aa"), NOW)).toBe("awaiting-listing");
    expect(listingStage(paid, listed, live(50n, "aa"), NOW)).toBe("listed");
    expect(listingStage(paid, listed, live(80n, "bb"), NOW)).toBe("needs-reapproval");
    expect(listingStage(paid, { ...listed, approvedSlot: 80n, approvedHash: "bb" }, live(80n, "bb"), NOW)).toBe("listed");
  });
  it("tells a moved slot with the same build apart from an upgrade", () => {
    expect(listingStage(paid, listed, live(60n, "aa"), NOW)).toBe("needs-refresh");
  });
  it("ends when the paid year or the on-chain time passes", () => {
    expect(listingStage(paid, listed, live(50n, "aa"), NOW + YEAR + 1)).toBe("expired");
    expect(listingStage({ status: "accepted", paidUntil: NOW + 10 }, { ...listed, listedUntil: NOW + YEAR }, live(50n, "aa"), NOW + 11)).toBe("expired");
    expect(listingStage({ status: "accepted", paidUntil: NOW - 1 }, null, null, NOW)).toBe("expired");
  });
  it("treats a never-approved record as not listed", () => {
    expect(listingStage(paid, { listedUntil: 0, approvedSlot: 0n, approvedHash: null }, live(1n, "aa"), NOW)).toBe("awaiting-listing");
  });
  it("features a Game only while it is listed", () => {
    expect(isFeaturedNow(true, "listed")).toBe(true);
    expect(isFeaturedNow(true, "needs-reapproval")).toBe(false);
    expect(isFeaturedNow(false, "listed")).toBe(false);
  });
});
