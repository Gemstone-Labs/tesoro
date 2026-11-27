/**
 * Open and join a Match: the orchestration over entry.ts (instructions) and ticket.ts (Tickets).
 * `openEntry` / `joinEntry` are what match-flow.ts (Queue, Challenge) and backing.ts (entering under a Backing) call.
 */
import { PublicKey } from "@solana/web3.js";
import { accountOfSigner, BLOCK_PUZZLE_PROGRAM_ID, isSeatKey, type ChainSigner } from "@/games/block-puzzle/chain";
import { cosigned, ticketSteps } from "@/lib/seat/cosigned";
import { seatKeys, type SeatKey } from "@/lib/seat/seat-key";
import { countingFor } from "@/lib/seat/signature-counter";
import type { GameId } from "@/lib/mock/types";
import { matchKeyOf, parseMatchKey } from "./match-id";
import type { GetToken } from "./demo-client";
import {
  freshPotNow,
  drawRemaining,
  joinFactsOf,
  joinGrowPlan,
  joinMatchIx,
  joinTransaction,
  matchAddress,
  openMatchIx,
  previewEntry,
  readEntryStores,
  readMatchState,
  relayerKey,
  sendEntryTx,
  studioRemaining,
  type BackingRef,
  type EntryPreview,
  type EntryStores,
  type MatchRef,
  type PotRef,
} from "./entry";
import { GAME_IDS } from "./games";
import { assertGameListed } from "./game-listing";
import { getChain } from "./client";
import { SponsorError, requestTable } from "./sponsor-client";
import { prepareEntryTicket, readyBackingTicket, type StagedEntry } from "./ticket";
import { joinTargetTag, openTargetTag, seatSpends } from "./ticket-target";

/** The Account of a wallet. Callers pass the wallet, never a seat key. */
const accountOf = (wallet: PublicKey) => accountOfSigner({ publicKey: wallet });

/** The seat key for this Match on this device (made now when there is none), named in the entry. The wallet signs once, the key co-signs. */
async function seatFor(wallet: ChainSigner, matchKey: string): Promise<SeatKey> {
  if (isSeatKey(wallet)) throw new Error("An entry is signed by the wallet.");
  countingFor(matchKey);
  return seatKeys().forMatch(matchKey, wallet.publicKey);
}

export const matchRefOf = (key: string): MatchRef => {
  const k = parseMatchKey(key);
  if (!k) throw new Error(`Not a Match key: ${key}`);
  return { opener: new PublicKey(k.opener), n: k.n };
};

/** What an entry will do, before any signature: read the stores of whoever funds it and plan the draw. */
export async function planEntryFor(signer: PublicKey, entry: number, backing?: BackingRef): Promise<{ stores: EntryStores; preview: EntryPreview }> {
  const funder = backing ? backing.backerAccount : accountOf(signer);
  const stores = await readEntryStores(funder);
  return { stores, preview: previewEntry(stores, BigInt(entry), { backing: !!backing }) };
}

interface EntryArgs {
  /** The Player's wallet. */
  signer: ChainSigner;
  /** The seat key this entry names; set by `openEntry` and `joinEntry`. */
  seat?: SeatKey;
  getToken: GetToken;
  game: GameId;
  entry: number;
  backing?: BackingRef;
  onStep?: (s: string) => void;
  /** A prepared Ticket is being staged (large entries): progress for the screen. */
  onStaged?: (s: StagedEntry) => void;
}

/**
 * The Pot of this entry: a fresh account for a direct draw, a complete Entry Ticket for a long one, and for a Backed
 * entry always its Backing Ticket (a direct draw of the Backer's Gemas names their books: with a seat key it does not
 * fit one transaction, `backed-entry-size.test.ts`).
 */
async function potFor(
  a: EntryArgs,
  preview: EntryPreview,
  targetTag: bigint,
): Promise<{ pot: () => Promise<PotRef>; lines: number; remaining: Awaited<ReturnType<typeof drawRemaining>>; seatAlone: boolean }> {
  const funder = a.backing ? a.backing.backerAccount : accountOf(a.signer.publicKey);
  // a fresh Pot takes the funder's next_ticket, read again every time the transaction is built (a retry, a self-paid rebuild)
  if (!a.backing && !preview.needsTicket) return { pot: () => freshPotNow(funder, preview.potLines), lines: preview.potLines, remaining: await drawRemaining(preview.plan), seatAlone: false };
  a.onStep?.("Preparing your entry…");
  const base = { signer: a.signer, seat: a.seat, getToken: a.getToken, game: a.game, entry: BigInt(a.entry), lines: preview.ticketLines, onProgress: a.onStaged };
  const t = a.backing ? await readyBackingTicket({ ...base, ...a.backing }) : await prepareEntryTicket({ ...base, targetTag });
  const pot: PotRef = { address: t.address, nonce: t.nonce, lines: t.lineCap, ticket: true };
  return { pot: async () => pot, lines: pot.lines, remaining: [], seatAlone: !a.backing && seatSpends(t, targetTag) };
}

/**
 * Who signs the entry's last step. The seat key alone when the Ticket allows it (the wallet signed `open_ticket`); the wallet
 * with the seat key otherwise, and always when the Player pays the fee (the wallet is the fee payer).
 */
const entrantOf = (wallet: ChainSigner, seat: SeatKey, seatAlone: boolean) => (seatAlone ? ticketSteps(wallet, seat) : cosigned(wallet, seat));

/** Sends with the seat key alone when allowed; when the sponsor wants the wallet after all (`wallet-signs`), once more with it. */
async function withSeatFallback<T>(seatAlone: boolean, send: (alone: boolean) => Promise<T>): Promise<T> {
  if (!seatAlone) return send(false);
  try {
    return await send(true);
  } catch (e) {
    if (e instanceof SponsorError && e.code === "wallet-signs") return send(false);
    throw e;
  }
}

export interface OpenedEntry {
  key: string;
  sig: string;
}

/** Opens a Match. `n` comes from the opener's counter, so the key is known before the transaction lands. */
export async function openEntry(a: EntryArgs & { challenge: boolean; asset?: number }): Promise<OpenedEntry> {
  await assertGameListed(getChain().base, GAME_IDS[a.game]);
  const me = accountOf(a.signer.publicKey);
  const own = await readEntryStores(me);
  const n = own.nextMatch;
  const key = matchKeyOf({ opener: me.toBase58(), n });
  // the key exists before the Match does, and is kept under the Match's key: a reload while the entry is prepared finds it again
  const seat = await seatFor(a.signer, key);
  const withSeat = { ...a, seat };
  const { preview } = await planEntryFor(a.signer.publicKey, a.entry, a.backing);
  const asset = a.asset ?? 0;
  const { pot, remaining, seatAlone } = await potFor(withSeat, preview, await openTargetTag(matchAddress({ opener: me, n }), a.challenge, asset));
  const { sig } = await withSeatFallback(seatAlone, (alone) =>
    sendEntryTx(
      entrantOf(a.signer, seat, alone),
      a.getToken,
      async (payer, sponsored) => [
        openMatchIx({ payer, player: a.signer.publicKey, seatSigner: seat.publicKey, walletSigns: !(alone && sponsored), game: a.game, entry: BigInt(a.entry), n, challenge: a.challenge, asset, pot: await pot(), backing: a.backing, remaining }),
      ],
      { selfPay: cosigned(a.signer, seat) },
    ),
  );
  return { key, sig };
}

/** Joins an open Match with an equal entry (grows the holds' room first when the relayer pays). */
export async function joinEntry(a: EntryArgs & { key: string }): Promise<string> {
  const ref = matchRefOf(a.key);
  const state = await readMatchState(ref);
  if (!state) throw new Error("This Match does not exist.");
  const facts = joinFactsOf(state);
  const me = accountOf(a.signer.publicKey);
  const funder = a.backing ? a.backing.backerAccount : me;
  const seat = await seatFor(a.signer, a.key);
  const { preview } = await planEntryFor(a.signer.publicKey, a.entry, a.backing);
  const { pot: getPot, lines, remaining, seatAlone } = await potFor({ ...a, seat }, preview, await joinTargetTag(matchAddress(ref)));

  const accounts = [...new Map([facts.openerPlayer, facts.openerFunder, me, funder, ...(facts.outsideStudio ? [facts.outsideStudio] : [])].map((k) => [k.toBase58(), k])).values()];
  const read = new Map((await Promise.all(accounts.map((k) => readEntryStores(k)))).map((s) => [s.account.toBase58(), s]));
  const needs = joinGrowPlan(facts, lines, me, funder, (k) => read.get(k.toBase58()));
  const relayer = await relayerKey();
  const selfPay = cosigned(a.signer, seat);
  // built per send: the Pot's nonce is the funder's counter as it is now, so a retry rereads it; the wallet signs when it pays
  const joinWith = async (payer: PublicKey, walletSigns: boolean) =>
    joinMatchIx({ payer, player: a.signer.publicKey, seatSigner: seat.publicKey, walletSigns, match: ref, facts, pot: await getPot(), backing: a.backing, remaining: [...remaining, ...studioRemaining(facts.outsideStudio, ref)] });

  // Grows need the relayer to sign, so they only travel in the sponsored transaction; sized to what it carries.
  if (relayer) {
    const { earlier } = joinTransaction(true, relayer, needs, await joinWith(relayer, !seatAlone));
    // the grows are best effort: a join is never refused for room, so a refused grow does not stop it (the relayer signs them)
    for (const grows of earlier) await sendEntryTx(entrantOf(a.signer, seat, seatAlone), a.getToken, async () => grows).catch(() => undefined);
    const r = await withSeatFallback(seatAlone, (alone) =>
      sendEntryTx(
        entrantOf(a.signer, seat, alone),
        a.getToken,
        async (payer, sponsored) => {
          if (sponsored) return joinTransaction(true, relayer, needs, await joinWith(relayer, !alone)).main;
          return [await joinWith(payer, true)];
        },
        { assign: true, selfPay },
      ),
    );
    askForTable(r.table, seat, a.getToken, ref);
    return r.sig;
  }
  const r = await sendEntryTx(selfPay, a.getToken, async (payer) => [await joinWith(payer, true)], { assign: true });
  askForTable(r.table, seat, a.getToken, ref);
  return r.sig;
}

/** A join that travelled without its table: once it confirms, the seat key asks for the table (the page does not wait for it). */
function askForTable(needed: boolean, seat: SeatKey, getToken: GetToken, ref: MatchRef) {
  if (needed) void requestTable(seat, getToken, matchAddress(ref)).catch(() => undefined);
}

export { GAME_IDS, BLOCK_PUZZLE_PROGRAM_ID, matchAddress };
