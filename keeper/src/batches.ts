import anchor from "@coral-xyz/anchor";
import { PublicKey, type AccountMeta, type Keypair } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import {
  BATCH_DONE,
  BATCH_OPEN,
  BATCH_SEALED,
  MAX_BATCH_ENTRIES,
  PAYOUT_PAID,
  PAYOUT_PENDING,
  PAYOUT_REFUNDED,
  PAYOUT_REJECTED,
  addToBatchIx,
  batchPda,
  bridgeDisc,
  chainOfEid,
  closeBatchIx,
  closePayoutIx,
  decodeBatch,
  decodePayout,
  decodeRoute,
  fundSeasonPrizeEvmIx,
  openBatchIx,
  refundPrizePayoutIx,
  sealBatchIx,
  sendBatchIx,
  sendPayPrizeIx,
  vaultPositionId,
  vaultWordOf,
  type BatchRow,
  type PayoutRow,
  type RouteRow,
} from "./bridge-ix.ts";
import { MIN_GEMAS, RETRY_MS, candidates, due, nextTry, type Candidate, type CounterDeps } from "./counters.ts";
import { shortKey } from "./env.ts";
import { BRIDGE, quoteFee, sendAccounts } from "./lz.ts";
import { basketOf, configAddress, economyAddress, keyOf, pda, prizeSourceOf, spillOf } from "./kit.ts";
import { fetchWithBackoff } from "./runtime.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { connReader, dedupe, supplySources, type Reader } from "./supply.ts";
import { simulate } from "./tee.ts";

/** A sealed batch or a pending payout is sent again this often until the vault has answered in full. */
const RESEND_MS = Number(process.env.KEEPER_BATCH_RESEND_SECS ?? 30 * 60) * 1000;
const lastSent = new Map<string, number>();

export const KIND_NAMES = ["Platform", "Studio", "Leaderboard"] as const;

// ---- Plans (pure) -------------------------------------------------------------------------------------------------------

export type BatchStep = { kind: "seal"; batch: BatchRow } | { kind: "send"; batch: BatchRow } | { kind: "close"; batch: BatchRow };

export const routeKey = (eid: number, peerAddress: Uint8Array) => `${eid}:${Buffer.from(peerAddress).toString("hex")}`;

/**
 * What to do with each batch: close a Done one (its rent goes back), send a Sealed one that is owed units (at once the first
 * time, again every `resendMs` until the acknowledgements add up: a message can be lost, never replayed into a double
 * payment), and seal an Open one that holds entries and reached the route's minimum or its entry limit.
 */
export function planBatches(batches: BatchRow[], routes: Map<string, RouteRow>, sentAt: Map<string, number>, nowMs: number, resendMs: number): BatchStep[] {
  const out: BatchStep[] = [];
  for (const batch of batches) {
    if (batch.state === BATCH_DONE) out.push({ kind: "close", batch });
    else if (batch.state === BATCH_SEALED) {
      if (batch.totalUnits > batch.paidUnits && nowMs - (sentAt.get(batch.address.toBase58()) ?? 0) >= resendMs) out.push({ kind: "send", batch });
    } else if (batch.state === BATCH_OPEN && batch.count > 0) {
      const route = routes.get(routeKey(batch.eid, batch.peerAddress));
      if (route && (batch.totalUnits >= route.minBatchUnits || batch.count >= MAX_BATCH_ENTRIES)) out.push({ kind: "seal", batch });
    }
  }
  return out;
}

export type PayoutStep = { kind: "send"; payout: PayoutRow } | { kind: "refund"; payout: PayoutRow } | { kind: "close"; payout: PayoutRow };

/** A Pending payout is (re)sent until the vault answers; a Rejected one is refunded to the holder; a Paid or Refunded one is closed. */
export function planPayouts(payouts: PayoutRow[], sentAt: Map<string, number>, nowMs: number, resendMs: number): PayoutStep[] {
  const out: PayoutStep[] = [];
  for (const payout of payouts) {
    if (payout.state === PAYOUT_PENDING) {
      if (nowMs - (sentAt.get(payout.address.toBase58()) ?? 0) >= resendMs) out.push({ kind: "send", payout });
    } else if (payout.state === PAYOUT_REJECTED) out.push({ kind: "refund", payout });
    else if (payout.state === PAYOUT_PAID || payout.state === PAYOUT_REFUNDED) out.push({ kind: "close", payout });
  }
  return out;
}

/** The route (vault) an EVM Source belongs to: same chain, and the Position id's first 20 bytes are the vault. */
export const routeOf = (routes: RouteRow[], c: Pick<Candidate, "chain" | "positionId">): RouteRow | null =>
  routes.find((r) => chainOfEid(r.eid) === c.chain && r.peerAddress.equals(vaultWordOf(c.positionId.subarray(0, 20)))) ?? null;

/** Fee classes a route's batches carry: Platform and Studio always, the Leaderboard's only with the prize escrow on. */
export const kindsOf = (route: RouteRow): number[] => (route.escrowEnabled ? [0, 1, 2] : [0, 1]);

// ---- The job ------------------------------------------------------------------------------------------------------------------

export interface BatchDeps extends CounterDeps {
  listBridge(disc: Buffer): Promise<{ pubkey: PublicKey; data: Buffer }[]>;
  /** The LayerZero fee and send accounts of a message to a vault. */
  lz(eid: number, peerAddress: Uint8Array, msgType: number): Promise<{ fee: bigint; send: AccountMeta[] }>;
}

export const realBatchDeps = (ctx: Ctx, base: CounterDeps): BatchDeps => ({
  ...base,
  listBridge: async (disc) => (await ctx.conn.getProgramAccounts(BRIDGE, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: anchorBs58(disc) } }] })).map((a) => ({ pubkey: a.pubkey, data: Buffer.from(a.account.data) })),
  lz: async (eid, peerAddress, msgType) => {
    const id = vaultPositionId(peerAddress);
    const acc = await sendAccounts(ctx, eid, id);
    return { fee: await quoteFee(ctx, eid, id, msgType, acc.quote), send: acc.send };
  },
});

const anchorBs58 = (b: Buffer) => anchor.utils.bytes.bs58.encode(b);

async function fee(ctx: Ctx, subject: string, what: string, lz: { fee: bigint }): Promise<boolean> {
  if (Number(lz.fee) > ctx.settings.maxLzFeeLamports) {
    log("batches", subject, `SKIP ${what}: LayerZero fee ${Number(lz.fee) / 1e9} SOL is above the per-message cap ${ctx.settings.maxLzFeeLamports / 1e9} SOL`);
    return false;
  }
  if (ctx.lz.spentLastHour() + Number(lz.fee) > ctx.settings.lzHourlyCapLamports) {
    log("batches", subject, `SKIP ${what}: hourly LayerZero fee cap reached`);
    return false;
  }
  return true;
}

/** The recipient Account of each fee class: Platform and Studio from the settings, the Leaderboard's is the Pool. */
export async function feeRecipients(ctx: Ctx, read: Reader): Promise<(PublicKey | null)[]> {
  const [configInfo, economyInfo] = await read.many([configAddress, economyAddress]);
  const config: any = configInfo ? ctx.core.coder.accounts.decode("config", configInfo.data) : null;
  const economy: any = economyInfo ? ctx.core.coder.accounts.decode("economyConfig", economyInfo.data) : null;
  const pick = (k: PublicKey | null) => (k && !k.equals(PublicKey.default) ? k : null);
  return [config ? pick(keyOf(config.platformRecipient)) : null, economy ? pick(keyOf(economy.tesoroStudio)) : null, config ? pick(keyOf(config.poolAccount)) : null];
}

/**
 * Job: the Solana side of ETH and HYPE fee cash-ins and prize payouts (ticket 16, docs/cross-chain.md).
 *   1. fill: each EVM Source with a covered Platform, Studio or Leaderboard counter goes into its route's open batch
 *      (`open_batch` + `add_to_batch`; a free dry run says whether anything is ready);
 *   2. seal a batch that reached the route minimum, send a sealed one and send it AGAIN every KEEPER_BATCH_RESEND_SECS until
 *      the vault's acknowledgements add up (`owed` 0), close a Done one;
 *   3. prize payouts: send a Pending one again until the vault answers, refund a Rejected one to its holder, close a final one.
 * Everything is permissionless and idempotent in the bridge; the sends cost a LayerZero fee, capped per message and per hour.
 */
export async function batchJob(ctx: Ctx, d: BatchDeps): Promise<number> {
  const routes = (await d.listBridge(bridgeDisc.route)).map((r) => decodeRoute(r.pubkey, r.data));
  if (!routes.length) return 0;
  const byKey = new Map(routes.map((r) => [routeKey(r.eid, r.peerAddress), r]));
  let actions = await fillBatches(ctx, d, routes);

  const batches = (await d.listBridge(bridgeDisc.batch)).map((b) => decodeBatch(b.pubkey, b.data));
  for (const step of planBatches(batches, byKey, lastSent, Date.now(), RESEND_MS)) {
    const b = step.batch;
    const subject = `batch=${shortKey(b.address)}#${b.id}`;
    try {
      if (step.kind === "seal") actions += +(await act(ctx, "batches", subject, `seal_batch (${b.count} entries, ${b.totalUnits} units, ${KIND_NAMES[b.kind]})`, () => d.send([sealBatchIx(b)], {}))).ok;
      else if (step.kind === "close") actions += +(await act(ctx, "batches", subject, "close_batch (every entry acknowledged)", () => d.send([closeBatchIx(b)], {}))).ok;
      else actions += await sendBatch(ctx, d, b, subject);
    } catch (e) {
      log("batches", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }

  const payouts = (await d.listBridge(bridgeDisc.payout)).map((p) => decodePayout(p.pubkey, p.data));
  for (const step of planPayouts(payouts, lastSent, Date.now(), RESEND_MS)) {
    const p = step.payout;
    const subject = `payout=${shortKey(p.address)}#${p.id}`;
    try {
      if (step.kind === "close") actions += +(await act(ctx, "batches", subject, "close_payout (final)", () => d.send([closePayoutIx(p)], {}))).ok;
      else if (step.kind === "refund") {
        const ix = refundPrizePayoutIx({ payout: p, holderBasket: basketOf(p.holderAccount), holderSpill: spillOf(p.holderAccount) });
        actions += +(await act(ctx, "batches", subject, `refund_prize_payout (the vault rejected it: ${p.gemas} Gemas back to the holder)`, () => d.send([ix], { units: 300_000 }))).ok;
      } else actions += await sendPayout(ctx, d, p, subject);
    } catch (e) {
      log("batches", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  log("batches", "-", `${routes.length} route(s), ${batches.length} batch(es), ${payouts.length} payout(s), ${actions} action(s), LayerZero fees ${(ctx.lz.spentLastHour() / 1e9).toFixed(5)} SOL this hour`);
  return actions;
}

async function sendBatch(ctx: Ctx, d: BatchDeps, b: BatchRow, subject: string): Promise<number> {
  const lz = await d.lz(b.eid, b.peerAddress, 6);
  const what = `send_batch (${b.totalUnits - b.paidUnits} of ${b.totalUnits} units owed, send #${b.sends + 1})`;
  if (!(await fee(ctx, subject, what, lz))) return 0;
  const ixs = [sendBatchIx({ payer: ctx.payer.publicKey, batch: b, nativeFee: lz.fee, send: lz.send })];
  const why = await d.simulate(ixs);
  if (why) {
    log("batches", subject, `wait: ${what} would fail (${why.slice(0, 160)})`);
    return 0;
  }
  const r = await act(ctx, "batches", subject, `${what}, LayerZero fee ${Number(lz.fee) / 1e9} SOL`, () => d.send(ixs, { units: 600_000 }));
  if (r.ok && !ctx.settings.dryRun) {
    ctx.lz.record(Number(lz.fee));
    lastSent.set(b.address.toBase58(), Date.now());
  }
  return +r.ok;
}

async function sendPayout(ctx: Ctx, d: BatchDeps, p: PayoutRow, subject: string): Promise<number> {
  const lz = await d.lz(p.eid, p.peerAddress, 7);
  const what = `send_pay_prize (${p.shares} shares)`;
  if (!(await fee(ctx, subject, what, lz))) return 0;
  const ixs = [sendPayPrizeIx({ payer: ctx.payer.publicKey, payout: p, nativeFee: lz.fee, send: lz.send })];
  const why = await d.simulate(ixs);
  if (why) {
    log("batches", subject, `wait: ${what} would fail (${why.slice(0, 160)})`);
    return 0;
  }
  const r = await act(ctx, "batches", subject, `${what}, LayerZero fee ${Number(lz.fee) / 1e9} SOL`, () => d.send(ixs, { units: 600_000 }));
  if (r.ok && !ctx.settings.dryRun) {
    ctx.lz.record(Number(lz.fee));
    lastSent.set(p.address.toBase58(), Date.now());
  }
  return +r.ok;
}

/** Step 1: puts covered counters of EVM Sources into their routes' open batches. */
async function fillBatches(ctx: Ctx, d: BatchDeps, routes: RouteRow[]): Promise<number> {
  const recipients = await feeRecipients(ctx, d.read);
  const wanted = routes.some((r) => kindsOf(r).some((k) => !!recipients[k]));
  if (!wanted) return 0;
  const list = await candidates(ctx, d, "batches", (c) => c.chain !== "solana" && !c.custody, (c) => c.some((v, k) => k <= 2 && v >= MIN_GEMAS));
  if (!list.length) return 0;
  const open = new Map<string, BatchRow>();
  for (const b of (await d.listBridge(bridgeDisc.batch)).map((x) => decodeBatch(x.pubkey, x.data))) if (b.state === BATCH_OPEN) open.set(`${routeKey(b.eid, b.peerAddress)}:${b.kind}`, b);
  let actions = 0;
  for (const c of list) {
    const route = routeOf(routes, c);
    if (!route) continue;
    for (const kind of kindsOf(route)) {
      const recipient = recipients[kind];
      if (!recipient || c.counters[kind] < MIN_GEMAS) continue;
      const tryKey = `batch:${c.source.toBase58()}:${kind}`;
      if (!due(tryKey, Date.now())) continue;
      const slot = `${routeKey(route.eid, route.peerAddress)}:${kind}`;
      let batch = open.get(slot) ?? null;
      if (batch && batch.count >= MAX_BATCH_ENTRIES) continue;
      const subject = `source=${shortKey(c.source)}`;
      const supply = await supplySources(ctx.core, d.read, [{ source: c.source, cut: false }]);
      const opening = batch === null;
      const target: BatchRow =
        batch ??
        ({ address: batchPda(route.eid, route.peerAddress, route.lastBatchId + 1n), eid: route.eid, peerAddress: route.peerAddress, id: route.lastBatchId + 1n, rentPayer: ctx.payer.publicKey, kind, state: BATCH_OPEN, count: 0, totalUnits: 0n, paidUnits: 0n, sends: 0 } satisfies BatchRow);
      const ixs = [
        ...(opening ? [openBatchIx({ payer: ctx.payer.publicKey, route, kind })] : []),
        addToBatchIx({ batch: target, chain: c.chain as "ethereum" | "hyperEvm", recipientAccount: recipient, position: c.position, source: c.source, remaining: dedupe(supply.metas) }),
      ];
      const why = await d.simulate(ixs);
      if (why) {
        nextTry.set(tryKey, Date.now() + RETRY_MS);
        log("batches", subject, `wait: nothing to add for ${KIND_NAMES[kind]} yet (${why.slice(0, 100)})`);
        continue;
      }
      const r = await act(ctx, "batches", subject, `${opening ? "open_batch + " : ""}add_to_batch (${KIND_NAMES[kind]} counter ${c.counters[kind]} Gemas)`, () => d.send(ixs, { units: 800_000 }));
      actions += +r.ok;
      if (r.ok && !ctx.settings.dryRun) {
        if (opening) {
          route.lastBatchId += 1n;
          open.set(slot, { ...target, count: 1 });
        } else open.set(slot, { ...target, count: target.count + 1 });
      }
    }
  }
  return actions;
}

// ---- EVM prizes ---------------------------------------------------------------------------------------------------------------

/** Public USD price of an EVM route's asset, for the oracle-priced path (the asset has no Pyth `OnchainPrice`). */
export async function evmAssetUsd(chain: "ethereum" | "hyperEvm", fetchFn: typeof fetch = fetchWithBackoff as typeof fetch): Promise<number> {
  const id = chain === "ethereum" ? "ethereum" : "hyperliquid";
  const res = await fetchFn(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const usd = Number(((await res.json()) as Record<string, { usd?: number }>)[id]?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`no price for ${id}`);
  return usd;
}

/** Routes whose prize can be issued for season `n`: escrow on, not yet funded for a season this late, with confirmed escrow not issued yet. */
export const evmRoutesToFund = (routes: RouteRow[], n: number) => routes.filter((r) => r.escrowEnabled && r.lastFundedSeason < n && r.escrowShares > r.issuedShares);

export interface EvmPrizeDeps {
  listBridge: BatchDeps["listBridge"];
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  /** The oracle key, when this process has it (needed only for assets without a Pyth price). */
  oracle(): Keypair | null;
  usd(chain: "ethereum" | "hyperEvm"): Promise<number>;
}

/**
 * Issues the Leaderboard prize of every ETH/HYPE route with its escrow on, for season `n` (`fund_season_prize_evm`): one prize
 * Source for the escrow the vault has confirmed. `record_season` does not wait for these routes; a prize funded after it stays
 * in the Pool for a later Season. Signed by the Season keeper (and the oracle for an asset without a Pyth price).
 */
export async function fundEvmPrizes(ctx: Ctx, d: EvmPrizeDeps, n: number, authority: Keypair, pool: PublicKey): Promise<number> {
  const routes = (await d.listBridge(bridgeDisc.route)).map((r) => decodeRoute(r.pubkey, r.data));
  let actions = 0;
  for (const route of evmRoutesToFund(routes, n)) {
    const chain = chainOfEid(route.eid);
    if (!chain) continue;
    const subject = `season=${n}`;
    const asset = new PublicKey(route.asset);
    const onchain = pda("onchain_price", asset.toBuffer());
    const [info] = await d.read.many([onchain]);
    let price = 0n;
    let remaining: AccountMeta[] = [];
    let oracle: Keypair | null = null;
    if (info) {
      const feed = keyOf((ctx.core.coder.accounts.decode("onchainPrice", info.data) as any).feed);
      remaining = [{ pubkey: onchain, isSigner: false, isWritable: false }, { pubkey: feed, isSigner: false, isWritable: false }];
    } else {
      oracle = d.oracle();
      if (!oracle) {
        log("season", subject, `SKIP prize of route ${shortKey(route.address)}: the asset has no Pyth price and this keeper has no oracle key`);
        continue;
      }
      price = BigInt(Math.round((await d.usd(chain)) * 1e6));
    }
    const ix = fundSeasonPrizeEvmIx({
      payer: ctx.payer.publicKey,
      seasonAuthority: authority.publicKey,
      oracle: oracle?.publicKey ?? null,
      route,
      season: n,
      priceMicroUsd: price,
      poolAccount: pool,
      poolBasket: basketOf(pool),
      poolSpill: spillOf(pool),
      prizeSource: prizeSourceOf(route.address, n),
      remaining,
    });
    const signers = [authority, ...(oracle ? [oracle] : [])].filter((k) => !k.publicKey.equals(ctx.payer.publicKey));
    actions += +(await act(ctx, "season", subject, `fund_season_prize_evm (${chain} route ${shortKey(route.address)})`, () => d.send([ix], { units: 500_000, signers }))).ok;
  }
  return actions;
}

export const realEvmPrizeDeps = (ctx: Ctx, oracle: () => Keypair | null): EvmPrizeDeps => ({
  listBridge: async (disc) => (await ctx.conn.getProgramAccounts(BRIDGE, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: anchorBs58(disc) } }] })).map((a) => ({ pubkey: a.pubkey, data: Buffer.from(a.account.data) })),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  oracle,
  usd: (chain) => evmAssetUsd(chain),
});

export { simulate };
