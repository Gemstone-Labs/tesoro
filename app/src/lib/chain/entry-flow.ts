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
  freshPot,
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
import { getChain } from "./client";
import { GAME_IDS } from "./games";
import { potNonce } from "./entry";
import { prepareBackingTicket, prepareEntryTicket, type StagedEntry } from "./ticket";

const accountOf = (authority: PublicKey) => BlockPuzzleChain.coreAccount(authority);

export const matchRefOf = (key: string): MatchRef => {
  const k = parseMatchKey(key);
  if (!k) throw new Error(`Not a Match key: ${key}`);
  return { opener: new PublicKey(k.opener), n: k.n };
};

/** Block Burst opens or joins its Session in the same transaction; no other Game does. */
const withSession = (game: GameId) => game === "block-puzzle";

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
async function potFor(a: EntryArgs, preview: EntryPreview): Promise<{ pot: PotRef; remaining: Awaited<ReturnType<typeof drawRemaining>> }> {
  const funder = a.backing ? a.backing.backerAccount : accountOf(a.signer.publicKey);
  if (!preview.needsTicket) return { pot: freshPot(funder, preview.potLines), remaining: await drawRemaining(preview.plan) };
  a.onStep?.("Preparing your entry…");
  const nonce = potNonce();
  const base = { signer: a.signer, getToken: a.getToken, game: a.game, entry: BigInt(a.entry), lines: preview.ticketLines, nonce, onProgress: a.onStaged };
  const t = a.backing ? await prepareBackingTicket({ ...base, backerAccount: a.backing.backerAccount, offer: a.backing.offer }) : await prepareEntryTicket(base);
  return { pot: { address: t.address, nonce: t.nonce, lines: t.lineCap, ticket: true }, remaining: [] };
}

export interface OpenedEntry {
  key: string;
  sig: string;
}

/** Opens a Match. `n` comes from the opener's counter, so the key is known before the transaction lands. */
export async function openEntry(a: EntryArgs & { challenge: boolean; asset?: number }): Promise<OpenedEntry> {
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
        openMatchIx({ payer, player: a.signer.publicKey, game: a.game, entry: BigInt(a.entry), n, challenge: a.challenge, asset: a.asset ?? 0, pot, backing: a.backing, remaining }),
      ];
      if (withSession(a.game)) ixs.push(await getChain().openSessionIx(payer, key, a.signer.publicKey));
      return ixs;
    },
    { sponsorable: !withSession(a.game) },
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
  const { pot, remaining } = await potFor(a, preview);

  const accounts = [...new Map([facts.openerPlayer, facts.openerFunder, me, funder, ...(facts.outsideStudio ? [facts.outsideStudio] : [])].map((k) => [k.toBase58(), k])).values()];
  const read = new Map((await Promise.all(accounts.map((k) => readEntryStores(k)))).map((s) => [s.account.toBase58(), s]));
  const needs = joinGrowPlan(facts, pot.lines, me, funder, (k) => read.get(k.toBase58()));
  const relayer = await relayerKey();
  const join = joinMatchIx({ payer: relayer ?? a.signer.publicKey, player: a.signer.publicKey, match: ref, facts, pot, backing: a.backing, remaining: [...remaining, ...studioRemaining(facts.outsideStudio, ref)] });

  // Grows need the relayer to sign, so they only travel in the sponsored transaction; sized to what it carries.
  if (relayer && !withSession(a.game)) {
    const { earlier, main } = joinTransaction(true, relayer, needs, join);
    // the grows are best effort: a join is never refused for room, so a refused grow does not stop it
    for (const grows of earlier) await sendEntryTx(a.signer, a.getToken, async () => grows).catch(() => undefined);
    const r = await sendEntryTx(a.signer, a.getToken, async (payer, sponsored) => {
      if (sponsored) return main;
      return [joinMatchIx({ payer, player: a.signer.publicKey, match: ref, facts, pot, backing: a.backing, remaining: [...remaining, ...studioRemaining(facts.outsideStudio, ref)] })];
    });
    return r.sig;
  }
  const r = await sendEntryTx(
    a.signer,
    a.getToken,
    async (payer) => {
      const ixs = [joinMatchIx({ payer, player: a.signer.publicKey, match: ref, facts, pot, backing: a.backing, remaining: [...remaining, ...studioRemaining(facts.outsideStudio, ref)] })];
      if (withSession(a.game)) ixs.push(await getChain().joinSessionIx(payer, a.key, me));
      return ixs;
    },
    { sponsorable: false },
  );
  return r.sig;
}

export { GAME_IDS, BLOCK_PUZZLE_PROGRAM_ID, matchAddress };
