import { PublicKey } from "@solana/web3.js";
import { settledPda } from "../../app/src/lib/chain/basket.ts";
import { awayAccounts, planAway, type AwayStep } from "../../app/src/lib/chain/away-plan.ts";
import { protectionsPda } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";
import { clearRequestIx, expireOfferIx, refreshListingIx, refundMatchIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { gameRecordOf, keyOf } from "./kit.ts";
import { assignmentClosable } from "./scheduler.ts";
import { closeOldPairs, closeOldReceipts, groupsOf } from "./reclaim.ts";
import { listedGameOf, listingOutcome, listingStep, type SweepDeps } from "./sweeps.ts";
import { ticketJob, type TicketDeps } from "./tickets.ts";

/**
 * The daily janitor: Tesoro's own rent and Listings. One run reads what is due, sends it and exits (a timer starts it
 * once a day). Seven independent parts; a part with nothing due does nothing, and one that throws does not stop the others.
 * Every scan goes through the sliced V2 lister in `deps.list`.
 */

export const PARTS = ["tickets", "receipts", "pairs", "assignments", "listings", "apy", "away"] as const;
export type PartName = (typeof PARTS)[number];

export interface PartReport {
  name: PartName;
  actions: number;
  /** Why the part did nothing, or something worth reading in the log. */
  note?: string;
  error?: string;
}

export interface JanitorReport {
  parts: PartReport[];
  /** Things a person should hear about (a Listing was refreshed or lost). */
  alerts: { key: string; title: string; detail: string }[];
}

/** One Game's Assignments: the Matches that have one, and the close. */
export interface AssignmentSource {
  label: string;
  /** Matches that have an Assignment account (a sliced scan of the Game's program). */
  matches(): Promise<PublicKey[]>;
  close(match: PublicKey): Promise<string>;
}

export interface JanitorDeps extends TicketDeps, SweepDeps {
  assignments: AssignmentSource[];
  /** The slot each Game's program was last deployed in (bytes 4..12 of its ProgramData: a sliced read); null when unreadable. */
  deploySlots(games: PublicKey[]): Promise<(bigint | null)[]>;
  /** Publishes the trailing APY; null while the program has no instruction for it. */
  publishApy: (() => Promise<string>) | null;
}

const PER_RUN = 300;
const TICKET_PASSES = 10;

type Alerts = JanitorReport["alerts"];
type Part = (ctx: Ctx, d: JanitorDeps, alerts: Alerts) => Promise<Pick<PartReport, "actions" | "note">>;

const tickets: Part = async (ctx, d) => {
  let actions = 0;
  // A pass handles a fixed number of Tickets; go on until one finds nothing (a dry run sends nothing, so one pass).
  for (let i = 0; i < (ctx.settings.dryRun ? 1 : TICKET_PASSES); i++) {
    const n = await ticketJob(ctx, d);
    actions += n;
    if (!n) break;
  }
  return { actions, note: actions ? undefined : "no Ticket due" };
};

const receipts: Part = async (ctx, d) => {
  const r = await closeOldReceipts(ctx, d, "janitor", PER_RUN);
  return { actions: r.actions, note: r.due ? undefined : "no receipt due" };
};

const pairs: Part = async (ctx, d) => {
  const r = await closeOldPairs(ctx, d, "janitor", PER_RUN);
  return { actions: r.actions, note: r.due ? undefined : "no pair record due" };
};

const assignments: Part = async (ctx, d) => {
  let actions = 0;
  let closable = 0;
  for (const src of d.assignments) {
    const matches = await src.matches();
    for (const batch of groupsOf(matches, 100)) {
      const [live, receipts] = await Promise.all([d.read.many(batch), d.read.many(batch.map(settledPda))]);
      for (let i = 0; i < batch.length; i++) {
        if (!assignmentClosable(!!live[i], !!receipts[i])) continue;
        closable++;
        if (closable > PER_RUN) return { actions };
        actions += +(await act(ctx, "janitor", `${src.label} ${shortKey(batch[i])}`, "close_assignment (its Match is settled or gone)", () => src.close(batch[i]))).ok;
      }
    }
  }
  return { actions, note: closable ? undefined : "no spent Assignment" };
};

const listings: Part = async (ctx, d, alerts) => {
  const games = (await d.list("GameRecord")).map((r) => listedGameOf(r.pubkey, ctx.core.coder.accounts.decode("gameRecord", r.data))).filter((g) => ctx.now < g.listedUntil);
  if (!games.length) return { actions: 0, note: "no listed Game" };
  const slots = await d.deploySlots(games.map((g) => g.game));
  let actions = 0;
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const slot = slots[i];
    if (slot === null || listingStep(g, slot, ctx.now)?.kind !== "refresh") continue;
    const subject = `game=${shortKey(g.game)}`;
    const ix = await refreshListingIx(ctx.core, { gameRecord: gameRecordOf(g.game), game: g.game });
    const outcome = listingOutcome(await d.simulate([ix]));
    if (outcome === "changed") {
      alerts.push({ key: `listing:${g.game.toBase58()}`, title: "A listed Game was upgraded", detail: `The program of the listed Game ${g.game.toBase58()} changed since it was approved: it stays unlisted until the admin runs list_game with the new code hash (keeper/scripts/register-game.ts --list).` });
      log("janitor", subject, "ALERT the code changed: the Game is unlisted until list_game is run again");
    } else if (outcome === "ok") {
      const r = await act(ctx, "janitor", subject, "refresh_listing (the program was extended, its code is the approved code)", () => d.send([ix], { units: 1_400_000 }));
      actions += +r.ok;
      if (r.ok) alerts.push({ key: `listing-refreshed:${g.game.toBase58()}`, title: "A Listing was refreshed", detail: `The listed Game ${g.game.toBase58()} was deployed again with the approved code (usually someone extended its program). The Listing was refreshed.` });
    } else if (outcome === "other") log("janitor", subject, "WARN refresh_listing would fail for another reason; will retry tomorrow");
  }
  return { actions, note: actions ? undefined : "every Listing current" };
};

const apy: Part = async (ctx, d) => {
  if (!d.publishApy) return { actions: 0, note: "skipped: tesoro_core has no instruction to publish the trailing APY yet (mainnet-launch ticket 11)" };
  if (ctx.settings.dryRun) return { actions: 0, note: "dry-run: would publish the trailing APY" };
  return { actions: 1, note: await d.publishApy() };
};

const num = (n: { toString(): string }) => Number(n.toString());
const nameOf = (o: object) => Object.keys(o)[0].toLowerCase();

/**
 * Backstop for Break and Self-Exclusion (ADR 0012): a Player who starts one cleans up in their own transaction, so this finds
 * what a direct transaction or a race left open for an Account that is away: an unpaired Match, an open Request, an open
 * or accepted Offer. Every step is permissionless on chain with the owner's Protections account. It reads only the (small)
 * Protections accounts unless somebody is away, and logs each step it takes, because a find here means the Player's own cleanup missed it.
 */
const away: Part = async (ctx, d) => {
  const decode = (name: string, data: Buffer): any => ctx.core.coder.accounts.decode(name, data);
  const protections = (await d.list("ProtectionsState")).map((r) => decode("protectionsState", r.data));
  const set = awayAccounts(protections.map((p) => ({ account: keyOf(p.account), breakUntil: num(p.inner.breakUntil), selfExclusionUntil: num(p.inner.selfExclusionUntil) })), ctx.now);
  if (!set.size) return { actions: 0, note: "nobody is away" };
  const [matches, requests, offers] = await Promise.all([d.list("MatchState"), d.list("RequestState"), d.list("OfferState")]);
  const plan = planAway(
    set,
    matches.map((r) => {
      const m = decode("matchState", r.data);
      return { id: r.pubkey.toBase58(), stage: nameOf(m.inner.stage) as "open", game: keyOf(m.inner.game), opener: keyOf(m.inner.a.player) };
    }),
    requests.map((r) => ({ address: r.pubkey, status: nameOf(decode("requestState", r.data).inner.status), player: keyOf(decode("requestState", r.data).inner.player) })),
    offers.map((r) => {
      const o = decode("offerState", r.data).inner;
      return { address: r.pubkey, status: nameOf(o.status), backer: keyOf(o.backer), request: keyOf(o.request) };
    }),
  ).slice(0, PER_RUN);
  let actions = 0;
  for (const step of plan) actions += +(await awayStep(ctx, d, step)).ok;
  return { actions, note: `${set.size} away Account(s), ${plan.length} left-open step(s) found${plan.length ? ": the Player's own clean-up missed them" : ""}` };
};

function awayStep(ctx: Ctx, d: JanitorDeps, step: AwayStep) {
  const owner = shortKey(step.owner);
  const protections = protectionsPda(step.owner);
  if (step.kind === "refund-match") {
    const match = new PublicKey(step.matchId);
    return act(ctx, "janitor", `match=${shortKey(match)}`, `refund_match (opener ${owner} is away)`, async () =>
      d.send([await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: step.game, matchState: match, openerProtections: protections })], { units: 300_000 }),
    );
  }
  if (step.kind === "cancel-request") {
    return act(ctx, "janitor", `request=${shortKey(step.request)}`, `clear_request (owner ${owner} is away)`, async () =>
      d.send([await clearRequestIx(ctx.core, { caller: ctx.payer.publicKey, request: step.request, protections })], { units: 200_000 }),
    );
  }
  return act(ctx, "janitor", `offer=${shortKey(step.offer)}`, `expire_offer (Backer ${owner} is away)`, async () =>
    d.send([await expireOfferIx(ctx.core, { caller: ctx.payer.publicKey, backerAccount: step.owner, offer: step.offer, request: step.request, backerProtections: protections })], { units: 300_000 }),
  );
}

const IMPL: Record<PartName, Part> = { tickets, receipts, pairs, assignments, listings, apy, away };

/** Runs the parts in order; a part that throws is reported and the rest still run. */
export async function janitor(ctx: Ctx, d: JanitorDeps, only: readonly PartName[] = PARTS): Promise<JanitorReport> {
  const report: JanitorReport = { parts: [], alerts: [] };
  for (const name of PARTS.filter((p) => only.includes(p))) {
    try {
      const r = await IMPL[name](ctx, d, report.alerts);
      report.parts.push({ name, ...r });
    } catch (e) {
      report.parts.push({ name, actions: 0, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) });
    }
  }
  return report;
}
