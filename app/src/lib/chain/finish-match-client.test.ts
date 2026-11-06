import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ckptPda } from "./basket";

const relayer = Keypair.generate().publicKey;
const matchKey = Keypair.generate().publicKey;
const source = Keypair.generate().publicKey;

const state = vi.hoisted(() => ({ stage: "settling", pagesExist: false, sent: [] as string[] }));

vi.mock("./client", () => ({
  getChain: () => ({
    core: { account: { matchState: { fetchNullable: async () => (state.stage === "closed" ? null : { stage: state.stage }) } } },
    base: { getAddressLookupTable: async () => ({ value: null }) },
  }),
}));
vi.mock("./sponsor-client", () => ({
  SponsorError: class extends Error {},
  sponsorStatus: async () => ({ paused: false, relayer: relayer.toBase58(), tables: [] }),
  sponsoredSend: async (_s: unknown, _t: unknown, ixs: { data: Buffer }[]) => {
    const tag = ixs.length === 1 && ixs[0].data.length === 5 ? ixs[0].data.toString() : `pages:${ixs.length}`;
    state.sent.push(tag);
    if (tag.startsWith("pages")) state.pagesExist = true;
    if (tag === "chunk") state.stage = "closed";
    return `sig-${tag}`;
  },
}));
vi.mock("./settle-plan", async (importOriginal) => {
  const real = await importOriginal<typeof import("./settle-plan")>();
  const { TransactionInstruction } = await import("@solana/web3.js");
  return {
    ...real,
    connReader: () => ({}),
    viewOf: (address: PublicKey, a: { stage: string }) => ({ address, stage: a.stage, inner: { run: {} } }),
    loadMatch: async () => ({ stores: [{}] }),
    runOf: () => ({ phaseI: 0, lineI: 0 }),
    sourcesAhead: () => [],
    missingCutPages: async () => (state.pagesExist ? [] : [{ source, cls: 1, pageNo: 0, address: ckptPda(source, 1, 0) }, { source, cls: 3, pageNo: 0, address: ckptPda(source, 3, 0) }]),
    planSizedChunk: async () => ({ ix: new TransactionInstruction({ programId: relayer, keys: [], data: Buffer.from("chunk") }), missing: [] }),
    fits: async () => true,
  };
});

import { finishMatchFree } from "./finish-match-client";

const signer = { signSerialized: async (b: Uint8Array) => b } as never;

describe("finishMatchFree with a checkpoint page the chunk needs", () => {
  beforeEach(() => {
    state.stage = "settling";
    state.pagesExist = false;
    state.sent = [];
  });

  it("creates the missing pages through the sponsor and then sends the chunk", async () => {
    const r = await finishMatchFree(signer, async () => null, matchKey);
    expect(r.stalled).toBeUndefined();
    expect(r.done).toBe(true);
    expect(state.sent).toEqual(["pages:2", "chunk"]);
  });
});
