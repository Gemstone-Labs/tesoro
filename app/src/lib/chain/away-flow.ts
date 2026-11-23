import "./polyfill";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { configPda as railcarConfigPda, decodeConfig as decodeRailcarConfig } from "@/games/railcar/chain";
import { stepOffFor } from "@/games/railcar/step-off";
import { MAX_CLEANUP, PROTECTIONS_BYTES } from "@/server/sponsor/rules";
import { cancelOfferIx, cancelRequestIx } from "./backing";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { planAway, type AwayStep, type OpenMatchRow } from "./away-plan";
import { sendSponsoredOrOwn } from "./sponsored-or-own";
import { sponsorStatus } from "./sponsor-client";
import { loadCar, type LoadedCar } from "./many-seat-plan";
import type { SeatView } from "./many-seat";
import { connReader, fits, type Core, type Reader } from "./settle-plan";
import { protectionsPda } from "./native";
import { matchKeyOfState } from "./read";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const enumKey = (o: object) => Object.keys(o)[0];

/** Compute budget instructions the sponsor adds to every transaction (limit and price); sizing leaves room for them. */
const BUDGET = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];

/**
 * How many of `steps` (in order) travel with `lead` in one transaction: as many as the sponsor's bundle limit and the
 * 1,232-byte wire size allow (every signer the instructions name is counted).
 */
export function stepsThatFit(feePayer: PublicKey, lead: TransactionInstruction[], steps: TransactionInstruction[]): number {
  let n = 0;
  while (n < steps.length && n < MAX_CLEANUP && fits(feePayer, [...BUDGET, ...lead, ...steps.slice(0, n + 1)])) n++;
  return n;
}

/** The signed-in Account's unpaired Matches, open Requests and open or accepted Offers, read fresh from the chain. */
export async function readOwnOpenItems(owner: PublicKey): Promise<AwayStep[]> {
  const chain = getChain();
  const me = BlockPuzzleChain.coreAccount(owner);
  const [matchRows, reqRows, offerRows]: any[][] = await Promise.all([chain.core.account.matchState.all(), chain.core.account.requestState.all(), chain.core.account.offerState.all()]);
  const matches: OpenMatchRow[] = matchRows.map((m) => ({ id: matchKeyOfState(m.account), stage: enumKey(m.account.inner.stage) as OpenMatchRow["stage"], game: pk(m.account.inner.game), opener: pk(m.account.inner.a.player) }));
  return planAway(
    new Set([me.toBase58()]),
    matches,
    reqRows.map((r) => ({ address: r.publicKey, status: enumKey(r.account.inner.status), player: pk(r.account.inner.player) })),
    offerRows.map((o) => ({ address: o.publicKey, status: enumKey(o.account.inner.status), backer: pk(o.account.inner.backer), request: pk(o.account.inner.request) })),
  );
}

export async function awayStepIx(owner: PublicKey, payer: PublicKey, step: AwayStep): Promise<TransactionInstruction> {
  if (step.kind === "refund-match") return getChain().refundMatchIx(owner, payer, step.matchId);
  if (step.kind === "cancel-request") return cancelRequestIx(owner, step.request);
  return cancelOfferIx(owner, step.offer, step.request);
}

/** A seat the Player holds in a car still Boarding: starting a Break or Self-Exclusion steps them off it (Q40 review #2). */
export interface BoardingSeat {
  loaded: LoadedCar;
  seat: SeatView;
}

/**
 * The Player's seats in a car still taking seats, read fresh: Railcar's boarding car (one Queue, so one car boards at a time;
 * a full car leaves in the transaction that opens the next). None when Railcar is not set up or they hold no seat.
 */
export async function readOwnBoardingSeats(read: Reader, account: PublicKey): Promise<BoardingSeat[]> {
  const [config] = await read.many([railcarConfigPda()]);
  if (!config) return [];
  const match = decodeRailcarConfig(config.data).boardingMatch;
  if (match.equals(PublicKey.default)) return [];
  const loaded = await loadCar(read, match);
  if (!loaded || loaded.car.stage !== "boarding") return [];
  return loaded.seats.filter((s) => s.seated && s.player.equals(account)).map((seat) => ({ loaded, seat }));
}

/** One clean-up step of a Break: a step-off from a boarding car, or one of `planAway`'s. */
export type AwayItem = AwayStep | ({ kind: "step-off" } & BoardingSeat);

/** Step-offs first, so a seat in a car about to leave rides in the Break's own transaction whenever it fits. */
export const cleanupOrder = (seats: BoardingSeat[], steps: AwayStep[]): AwayItem[] => [...seats.map((s) => ({ kind: "step-off" as const, ...s })), ...steps];

/** The instruction of one clean-up step; a step-off is the Player's own (the wallet is the seat's Player). */
export async function awayItemIx(owner: PublicKey, payer: PublicKey, item: AwayItem, chain: { core: Core; read: Reader }): Promise<TransactionInstruction> {
  if (item.kind === "step-off") return stepOffFor(chain.core, chain.read, { caller: owner, loaded: item.loaded, seat: item.seat });
  return awayStepIx(owner, payer, item);
}

/** The relayer's rent for the Protections account, sent to the Player right before their first Break (the sponsor allows exactly this). */
const rentTopUp = (relayer: PublicKey, owner: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: relayer, toPubkey: owner, lamports });

/**
 * Sends the Break (`lead`) with as many clean-up items as fit (`fit`), then the rest in later bundles. If the first bundle
 * fails (an item moved since it was read) the Break goes through alone, then the clean-up is retried in later bundles;
 * whatever still fails is counted for the caller.
 */
export async function sendAwayBundles<T>(items: T[], d: { fit(withLead: boolean, rest: T[]): Promise<number>; send(withLead: boolean, batch: T[]): Promise<string> }): Promise<{ signature: string; cleaned: number; failed: number }> {
  const first = await d.fit(true, items);
  let signature: string;
  let cleaned = first;
  try {
    signature = await d.send(true, items.slice(0, first));
  } catch (e) {
    if (!first) throw e;
    signature = await d.send(true, []);
    cleaned = 0;
  }
  let failed = 0;
  let rest = items.slice(cleaned);
  while (rest.length) {
    const take = Math.max(1, await d.fit(false, rest));
    try {
      await d.send(false, rest.slice(0, take));
      cleaned += take;
    } catch {
      failed += take;
    }
    rest = rest.slice(take);
  }
  return { signature, cleaned, failed };
}

/**
 * Starts a Break or Self-Exclusion and cleans up in the same transaction: the Player steps off any Railcar car still
 * Boarding (first, so it rides with the Break when it fits: a car in its countdown would otherwise leave with them), their
 * unpaired Matches are refunded (the safety sweep runs each refund's chunks), their Requests withdrawn and their Offers
 * released; Matches already paired play out. The relayer pays the fee, and the receipt rent of each refund, when it can: a
 * Player with no SOL still gets away. Bundles hold as many steps as fit (`sendAwayBundles`); whatever still fails is counted
 * for the caller, and the daily janitor (Matches, Requests, Offers) and the safety sweep (a seat in a boarding car) catch it.
 *
 * The first Break creates the Protections account and the program makes the Player its rent payer, so while it does not exist
 * the sponsored transaction starts with the relayer sending the Player exactly that rent. When the relayer cannot pay, the
 * Player pays everything from their own SOL (topped up on the test cluster).
 */
export async function startAwayWithCleanup(signer: ChainSigner, getToken: GetToken, setIx: TransactionInstruction): Promise<{ signature: string; cleaned: number; failed: number }> {
  const owner = signer.publicKey;
  const account = BlockPuzzleChain.coreAccount(owner);
  const chain = { core: getChain().core as Core, read: connReader(getChain().base) };
  const [seats, steps, protections] = await Promise.all([readOwnBoardingSeats(chain.read, account), readOwnOpenItems(owner), getChain().base.getAccountInfo(protectionsPda(account))]);
  const items = cleanupOrder(seats, steps);
  const feePayer = await sponsorStatus().then((s) => new PublicKey(s.relayer), () => owner);
  const rent = protections ? 0 : await getChain().base.getMinimumBalanceForRentExemption(PROTECTIONS_BYTES);
  const needsRent = !protections;
  const ixsOf = (payer: PublicKey, batch: AwayItem[]) => Promise.all(batch.map((s) => awayItemIx(owner, payer, s, chain)));

  return sendAwayBundles(items, {
    fit: async (withLead, rest) => {
      const lead = withLead ? [...(needsRent ? [rentTopUp(feePayer, owner, rent)] : []), setIx] : [];
      return stepsThatFit(feePayer, lead, await ixsOf(feePayer, rest));
    },
    send: (withLead, batch) =>
      sendSponsoredOrOwn(signer, getToken, async (payer, sponsored) => {
        const lead = withLead ? [...(sponsored && needsRent ? [rentTopUp(payer, owner, rent)] : []), setIx] : [];
        const list = [...lead, ...(await ixsOf(payer, batch))];
        return sponsored ? list : [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...list];
      }),
  });
}
