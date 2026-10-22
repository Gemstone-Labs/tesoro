import { PublicKey } from "@solana/web3.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WaitingRecord } from "@/lib/chain/overflow";
import { WaitingForRoomView } from "./WaitingForRoom";

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const record = (gemas: bigint): WaitingRecord => ({ address: k(1), owner: k(2), payer: k(3), kind: 0, gemas, lines: 1, sources: [k(4)] });

describe("Gemas waiting for room", () => {
  it("says how many wait and offers a Claim", () => {
    const html = renderToStaticMarkup(<WaitingForRoomView records={[record(270n), record(30n)]} onClaim={() => undefined} />);
    expect(html).toContain("300 Gemas waiting for room");
    expect(html).toContain(">Claim<");
  });
  it("shows nothing when nothing waits", () => {
    expect(renderToStaticMarkup(<WaitingForRoomView records={[]} onClaim={() => undefined} />)).toBe("");
  });
  it("shows the failure and a busy button while claiming", () => {
    expect(renderToStaticMarkup(<WaitingForRoomView records={[record(5n)]} busy />)).toContain("Claiming");
    expect(renderToStaticMarkup(<WaitingForRoomView records={[record(5n)]} error="No room yet." onClaim={() => undefined} />)).toContain("No room yet.");
  });
});
