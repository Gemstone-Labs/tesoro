/**
 * Open and join a Match: the orchestration over entry.ts (instructions) and ticket.ts (Tickets).
 * `openEntry` / `joinEntry` are what match-flow.ts (Queue, Challenge) and backing.ts (entering under a Backing) call.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, BLOCK_PUZZLE_PROGRAM_ID, type ChainSigner } from "@/games/block-puzzle/chain";
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
import { prepareBackingTicket, prepareEntryTicket, type StagedEntry } from "./ticket";

const accountOf = (authority: PublicKey) => BlockPuzzleChain.coreAccount(authority);

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
  signer: ChainSigner;
  getToken: GetToken;
  game: GameId;
  entry: number;
  backing?: BackingRef;
  onStep?: (s: string) => void;
  /** A prepared Ticket is being staged (large entries): progress for the screen. */
  onStaged?: (s: StagedEntry) => void;
}

/** The Pot of this entry: a fresh account for a direct draw, a complete Ticket for a long one. */
async function potFor(a: EntryArgs, preview: EntryPreview): Promise<{ pot: () => Promise<PotRef>; lines: number; remaining: Awaited<ReturnType<typeof drawRemaining>> }> {
  const funder = a.backing ? a.backing.backerAccount : accountOf(a.signer.publicKey);
  // a fresh Pot takes the funder's next_ticket, read again every time the transaction is built (a retry, a self-paid rebuild)
  if (!preview.needsTicket) return { pot: () => freshPotNow(funder, preview.potLines), lines: preview.potLines, remaining: await drawRemaining(preview.plan) };
  a.onStep?.("Preparing your entry…");
  const base = { signer: a.signer, getToken: a.getToken, game: a.game, entry: BigInt(a.entry), lines: preview.ticketLines, onProgress: a.onStaged };
  const t = a.backing ? await prepareBackingTicket({ ...base, backerAccount: a.backing.backerAccount, offer: a.backing.offer }) : await prepareEntryTicket(base);
  const pot: PotRef = { address: t.address, nonce: t.nonce, lines: t.lineCap, ticket: true };
  return { pot: async () => pot, lines: pot.lines, remaining: [] };
}

export interface OpenedEntry {
  key: string;
  sig: string;
}

/** Opens a Match. `n` comes from the opener's counter, so the key is known before the transaction lands. */
export async function openEntry(a: EntryArgs & { challenge: boolean; asset?: number }): Promise<OpenedEntry> {
  await assertGameListed(getChain().base, GAME_IDS[a.game]);
  const me = accountOf(a.signer.publicKey);
  const [own, { stores, preview }] = await Promise.all([readEntryStores(me), planEntryFor(a.signer.publicKey, a.entry, a.backing)]);
  const { pot, remaining } = await potFor(a, preview);
  const n = own.nextMatch;
  const key = matchKeyOf({ opener: me.toBase58(), n });
  void stores;
  const { sig } = await sendEntryTx(
    a.signer,
    a.getToken,
    async (payer) => {
      const ixs: TransactionInstruction[] = [
        openMatchIx({ payer, player: a.signer.publicKey, game: a.game, entry: BigInt(a.entry), n, challenge: a.challenge, asset: a.asset ?? 0, pot: await pot(), backing: a.backing, remaining }),
      ];
      return ixs;
    },
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
  const { preview } = await planEntryFor(a.signer.publicKey, a.entry, a.backing);
  const { pot: getPot, lines, remaining } = await potFor(a, preview);

  const accounts = [...new Map([facts.openerPlayer, facts.openerFunder, me, funder, ...(facts.outsideStudio ? [facts.outsideStudio] : [])].map((k) => [k.toBase58(), k])).values()];
  const read = new Map((await Promise.all(accounts.map((k) => readEntryStores(k)))).map((s) => [s.account.toBase58(), s]));
  const needs = joinGrowPlan(facts, lines, me, funder, (k) => read.get(k.toBase58()));
  const relayer = await relayerKey();
  // built per send: the Pot's nonce is the funder's counter as it is now, so a retry rereads it
  const joinWith = async (payer: PublicKey) =>
    joinMatchIx({ payer, player: a.signer.publicKey, match: ref, facts, pot: await getPot(), backing: a.backing, remaining: [...remaining, ...studioRemaining(facts.outsideStudio, ref)] });

  // Grows need the relayer to sign, so they only travel in the sponsored transaction; sized to what it carries.
  if (relayer) {
    const { earlier } = joinTransaction(true, relayer, needs, await joinWith(relayer));
    // the grows are best effort: a join is never refused for room, so a refused grow does not stop it
    for (const grows of earlier) await sendEntryTx(a.signer, a.getToken, async () => grows).catch(() => undefined);
    const r = await sendEntryTx(a.signer, a.getToken, async (payer, sponsored) => {
      if (sponsored) return joinTransaction(true, relayer, needs, await joinWith(relayer)).main;
      return [await joinWith(payer)];
    }, { assign: true });
    return r.sig;
  }
  const r = await sendEntryTx(a.signer, a.getToken, async (payer) => [await joinWith(payer)], { assign: true });
  return r.sig;
}

export { GAME_IDS, BLOCK_PUZZLE_PROGRAM_ID, matchAddress };
