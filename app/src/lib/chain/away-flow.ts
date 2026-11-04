import "./polyfill";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { MAX_CLEANUP, PROTECTIONS_BYTES } from "@/server/sponsor/rules";
import { cancelOfferIx, cancelRequestIx } from "./backing";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { planAway, type AwayStep, type OpenMatchRow } from "./away-plan";
import { sendSponsoredOrOwn } from "./sponsored-or-own";
import { sponsorStatus } from "./sponsor-client";
import { fits } from "./settle-plan";
import { protectionsPda } from "./native";
import { matchKeyOfState } from "./read";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const enumKey = (o: object) => Object.keys(o)[0];

/** Compute budget instructions the sponsor adds to every transaction (limit and price); sizing leaves room for them. */
const BUDGET = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];

/**
 * How many of `steps` (in order) travel with `lead` in one transaction: as many as the sponsor's bundle limit and the
 * 1,232-byte wire size allow. `signers` are the keys that sign besides the fee payer.
 */
export function stepsThatFit(feePayer: PublicKey, signers: PublicKey[], lead: TransactionInstruction[], steps: TransactionInstruction[]): number {
  let n = 0;
  while (n < steps.length && n < MAX_CLEANUP && fits(feePayer, [...BUDGET, ...lead, ...steps.slice(0, n + 1)], { signers: [feePayer, ...signers] })) n++;
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

/** The relayer's rent for the Protections account, sent to the Player right before their first Break (the sponsor allows exactly this). */
const rentTopUp = (relayer: PublicKey, owner: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: relayer, toPubkey: owner, lamports });

/**
 * Starts a Break or Self-Exclusion and cleans up in the same transaction: the Player's unpaired Matches are refunded (the
 * safety sweep runs each refund's chunks), their Requests withdrawn and their Offers released; Matches already paired play out.
 * The relayer pays the fee, and the receipt rent of each refund, when it can: a Player with no SOL still gets away. Bundles
 * hold as many steps as fit. If the first bundle fails (an item moved since it was read) the Break goes through alone, then the
 * clean-up is retried in later bundles; whatever still fails is counted for the caller, and the daily janitor catches it.
 *
 * The first Break creates the Protections account and the program makes the Player its rent payer, so while it does not exist
 * the sponsored transaction starts with the relayer sending the Player exactly that rent. When the relayer cannot pay, the
 * Player pays everything from their own SOL (topped up on the test cluster).
 */
export async function startAwayWithCleanup(signer: ChainSigner, getToken: GetToken, setIx: TransactionInstruction): Promise<{ signature: string; cleaned: number; failed: number }> {
  const owner = signer.publicKey;
  const [steps, protections] = await Promise.all([readOwnOpenItems(owner), getChain().base.getAccountInfo(protectionsPda(BlockPuzzleChain.coreAccount(owner)))]);
  const feePayer = await sponsorStatus().then((s) => new PublicKey(s.relayer), () => owner);
  const rent = protections ? 0 : await getChain().base.getMinimumBalanceForRentExemption(PROTECTIONS_BYTES);
  const needsRent = !protections;

  const send = (lead: TransactionInstruction[], batch: AwayStep[]) =>
    sendSponsoredOrOwn(signer, getToken, async (payer, sponsored) => {
      const list = [...(sponsored && lead.length && needsRent ? [rentTopUp(payer, owner, rent)] : []), ...lead, ...(await Promise.all(batch.map((s) => awayStepIx(owner, payer, s))))];
      return sponsored ? list : [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...list];
    });
  const fitting = async (lead: TransactionInstruction[], rest: AwayStep[]) =>
    stepsThatFit(feePayer, [owner], lead.length && needsRent ? [rentTopUp(feePayer, owner, rent), ...lead] : lead, await Promise.all(rest.map((s) => awayStepIx(owner, feePayer, s))));

  const first = await fitting([setIx], steps);
  let signature: string;
  let cleaned = first;
  try {
    signature = await send([setIx], steps.slice(0, first));
  } catch (e) {
    if (!first) throw e;
    signature = await send([setIx], []);
    cleaned = 0;
  }
  let failed = 0;
  let rest = steps.slice(cleaned);
  while (rest.length) {
    const take = Math.max(1, await fitting([], rest));
    try {
      await send([], rest.slice(0, take));
      cleaned += take;
    } catch {
      failed += take;
    }
    rest = rest.slice(take);
  }
  return { signature, cleaned, failed };
}
