import { Keypair, type AccountMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { sponsoredInstructions } from "@/server/sponsor/service";
import { bookPda, ckptPda, ticketPda } from "./basket";
import { joinMatchIx, openMatchIx } from "./entry";
import { MAX_TX_ACCOUNTS, MAX_TX_BYTES, sizeOf } from "./tx-size";

/**
 * The head-to-head Backed entries as the sponsor sends them (relayer pays, the Player's wallet and seat key sign, the
 * sponsor's compute instructions in front, no lookup table): a direct draw of the Backer's Gemas from 4 Sources (each
 * Source's book and one checkpoint page in remaining accounts), and an entry from a complete Backing Ticket (no books).
 * Measured 2026-11-05: direct 1,379 B (open) and 1,461 B (join), over the limit, which is why a Backed entry always takes
 * its Backing Ticket (`entry-flow.ts`); from the Ticket 1,115 B and 1,197 B.
 */
const key = () => Keypair.generate().publicKey;
const relayer = key();
const player = key();
const seat = key();
const backerAccount = key();
const backing = { offer: key(), backerAccount };
const books = (n: number): AccountMeta[] =>
  Array.from({ length: n }, () => key()).flatMap((src) => [
    { pubkey: bookPda(src), isSigner: false, isWritable: true },
    { pubkey: ckptPda(src, 0, 0), isSigner: false, isWritable: true },
  ]);
const direct = { address: ticketPda(backerAccount, 3n), nonce: 3n, lines: 6, ticket: false };
const staged = { address: ticketPda(backerAccount, 3n), nonce: 3n, lines: 6, ticket: true };
const sent = (ix: ReturnType<typeof openMatchIx>) => sponsoredInstructions({ cu: 600_000, grows: [], ixs: [ix], assignment: null });
const open = (pot: typeof direct, remaining: AccountMeta[]) => openMatchIx({ payer: relayer, player, game: "block-puzzle", entry: 500n, n: 4n, challenge: false, asset: 0, pot, backing, remaining, seatSigner: seat });
const join = (pot: typeof direct, remaining: AccountMeta[]) =>
  joinMatchIx({ payer: relayer, player, match: { opener: key(), n: 1n }, facts: { game: key(), openerPlayer: key(), openerFunder: key() }, pot, backing, remaining, seatSigner: seat });

describe("head-to-head Backed entries on the wire", () => {
  const rows = [
    ["open_match, direct draw from 4 Sources", sent(open(direct, books(4)))],
    ["open_match, from a Backing Ticket", sent(open(staged, []))],
    ["join_match, direct draw from 4 Sources", sent(join(direct, books(4)))],
    ["join_match, from a Backing Ticket", sent(join(staged, []))],
  ] as const;
  const sizes = rows.map(([what, ixs]) => ({ what, ...sizeOf(relayer, [...ixs]) }));
  console.log(`head-to-head Backed entries, sponsored with a seat key, no lookup table:\n${sizes.map((s) => `  ${s.bytes} B (${MAX_TX_BYTES - s.bytes} under), ${s.accounts} accounts: ${s.what}`).join("\n")}`);

  it("an entry from a Backing Ticket fits one transaction with no lookup table: Backed entries always take one", () => {
    for (const s of sizes.filter((x) => x.what.endsWith("Backing Ticket"))) {
      expect(s.bytes, s.what).toBeLessThanOrEqual(MAX_TX_BYTES);
      expect(s.accounts, s.what).toBeLessThanOrEqual(MAX_TX_ACCOUNTS);
    }
  });
});
