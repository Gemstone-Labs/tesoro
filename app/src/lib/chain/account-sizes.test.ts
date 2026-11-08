import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { describe, expect, it, vi } from "vitest";
import { createListCache, parseQuery } from "../../server/gpa";
import { CURRENT_SIZE, onlyCurrentLayouts } from "./account-sizes";
import coreIdl from "./idl/tesoro_core.json";
import { SplitConnection, routeGpa } from "./split-connection";

describe("CURRENT_SIZE", () => {
  // A wrong MatchState length makes every Match list come back empty (or full of undecodable old records).
  it("matchState is the program's MatchState::SPACE", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../../programs/tesoro_core/src/state.rs", import.meta.url)), "utf8");
    const num = (re: RegExp) => Number(re.exec(src)?.[1]);
    const record = num(/impl MatchState \{[^}]*?RECORD_LEN: usize = (\d+);/s);
    const holds = num(/pub const ROOM_HOLDS: usize = (\d+);/);
    const holdLen = /impl RoomHold \{\s*pub const LEN: usize = 32 \+ (\d+);/.exec(src);
    expect(src).toMatch(/pub const SPACE: usize =\s*8 \+ 1 \+ Self::RECORD_LEN \+ 1 \+ 4 \+ 32 \+ 64 \+ ROOM_HOLDS \* RoomHold::LEN;/);
    expect(CURRENT_SIZE.matchState).toBe(8 + 1 + record + 1 + 4 + 32 + 64 + holds * (32 + Number(holdLen?.[1])));
  });
});

describe("onlyCurrentLayouts", () => {
  // The W3 core's grow_offer appends counted_in and ticket_nonce (17 B) to an Offer: both lengths are live on devnet.
  it("lists Offers of both layouts, 174 B and 191 B, and no older one", async () => {
    const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: vi.fn(), signAllTransactions: vi.fn() };
    const program = new Program(coreIdl as Idl, new AnchorProvider(new SplitConnection("http://127.0.0.1:1", routeGpa), wallet, {}));
    const offer = await program.coder.accounts.encode("offerState", {
      bump: 1,
      nonce: new BN(7),
      inner: { backer: [...Keypair.generate().publicKey.toBytes()], game: Array(32).fill(0), entry: new BN(500), playerShareBps: 5_000, request: Array(32).fill(0), status: { open: {} }, expiresAt: new BN(0), useBy: new BN(0), player: Array(32).fill(1), ticketOpen: false },
    });
    expect(offer.length).toBe(174);
    const rows = [offer, Buffer.concat([offer, Buffer.alloc(17)]), offer.subarray(0, 150)].map((data, i) => ({
      pubkey: Keypair.generate().publicKey.toBase58(),
      account: { data: [data.toString("base64"), "base64"], lamports: i + 1, owner: coreIdl.address, executable: false },
    }));
    const lists = createListCache({ fetch: (async () => Response.json({ jsonrpc: "2.0", id: 1, result: rows })) as typeof fetch });
    vi.stubGlobal("fetch", async (input: string) => Response.json(await lists.getAccounts(parseQuery(new URL(input, "http://127.0.0.1").searchParams))));
    try {
      onlyCurrentLayouts(program);
      const offers = await (program.account as unknown as Record<string, { all(): Promise<{ publicKey: PublicKey; account: { inner: { entry: BN } } }[]> }>).offerState.all();
      expect(offers.map((o) => o.publicKey.toBase58()).sort()).toEqual([rows[0].pubkey, rows[1].pubkey].sort());
      expect(offers.map((o) => o.account.inner.entry.toNumber())).toEqual([500, 500]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
