import { PublicKey, type AccountMeta, type Keypair } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { expireInstantRedeemIx, fillInstantRedeemIx, meta } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { economyAddress, keyOf, pda, sponsorAddress } from "./kit.ts";
import { ata, custodyOf, payingAccounts } from "./kind-pay.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { SIM_SOL_MINT, connReader, dedupe, supplySources, type Reader } from "./supply.ts";
import { simulate } from "./tee.ts";
import { decodeCorePosition } from "./position.ts";

// ---- Orders ----------------------------------------------------------------------------------------------------------

export interface OrderRow {
  address: PublicKey;
  /** The seller's TesoroAccount. */
  account: PublicKey;
  /** Who paid the order's rent: it comes back there when the order ends. */
  payer: PublicKey;
  /** The seller's wallet. */
  owner: PublicKey;
  /** The Source the order's Gemas belong to (bytes 11..43 of the order's line). */
  source: PublicKey;
  /** Gemas still for sale (bytes 43..51 of the line). */
  open: bigint;
  createdAt: number;
  expiresAt: number;
}

/** A decoded `InstantOrderState`. */
export function orderOf(address: PublicKey, o: any): OrderRow {
  const line = Buffer.from(o.line);
  return {
    address,
    account: keyOf(o.account),
    payer: keyOf(o.payer),
    owner: keyOf(o.owner),
    source: new PublicKey(line.subarray(11, 43)),
    open: line.readBigUInt64LE(43),
    createdAt: Number(o.createdAt.toString()),
    expiresAt: Number(o.expiresAt.toString()),
  };
}

/** Orders anyone may end: past `expires_at`, their unsold Gemas go back to the seller. */
export const planExpiry = (rows: OrderRow[], now: number): OrderRow[] => rows.filter((r) => now >= r.expiresAt);

// ---- The optional fill rule ------------------------------------------------------------------------------------------

export interface FillRule {
  /** Gemas the keeper may buy in one pass; 0 switches the rule off whatever the chain says. */
  maxGemasPerPass: bigint;
  ordersPerPass: number;
}

export const fillRuleFrom = (env: NodeJS.ProcessEnv = process.env): FillRule => ({
  maxGemasPerPass: BigInt(env.KEEPER_FILL_MAX_GEMAS ?? 0),
  ordersPerPass: Number(env.KEEPER_FILL_ORDERS_PER_PASS ?? 3),
});

export interface FillSettings {
  /** `EconomyConfig.keeper_fills`: the chain lets the keeper fill. */
  keeperFills: boolean;
  fillKeeper: PublicKey;
}

/**
 * The orders the keeper may fill now and how many Gemas of each, oldest first within the pass budget. Off unless BOTH the
 * chain switch (`keeper_fills`) is on and this process holds the `fill_keeper` key and was given a budget. Orders that expired
 * are left to `expire_instant_redeem`.
 */
export function planFills(rows: OrderRow[], now: number, rule: FillRule, settings: FillSettings, holds: (key: PublicKey) => boolean): { row: OrderRow; gemas: bigint }[] {
  if (!settings.keeperFills || rule.maxGemasPerPass <= 0n || !holds(settings.fillKeeper)) return [];
  const out: { row: OrderRow; gemas: bigint }[] = [];
  let budget = rule.maxGemasPerPass;
  for (const row of [...rows].filter((r) => r.open > 0n && now < r.expiresAt).sort((a, b) => a.createdAt - b.createdAt)) {
    if (budget <= 0n || out.length >= rule.ordersPerPass) break;
    const gemas = row.open < budget ? row.open : budget;
    out.push({ row, gemas });
    budget -= gemas;
  }
  return out;
}

/** The sizes tried for a fill: the planned amount, then halves, so a fill the Treasury cannot fully pay still buys what it can. */
export const fillSizes = (gemas: bigint, tries = 4): bigint[] => {
  const out: bigint[] = [];
  for (let g = gemas, i = 0; g > 0n && i < tries; g /= 2n, i++) out.push(g);
  return out;
};

// ---- The job ---------------------------------------------------------------------------------------------------------

export interface OrderDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  /** A free dry run of a transaction: null when it would succeed, else why not. */
  simulate(ixs: Parameters<typeof sendIxs>[2]): Promise<string | null>;
  rule: FillRule;
  /** Keys this process can sign a fill with. */
  candidates(): (Keypair | null)[];
}

export const realOrderDeps = (ctx: Ctx): OrderDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  simulate: (ixs) => simulate(ctx.conn, ctx.payer, ixs),
  rule: fillRuleFrom(),
  candidates: () => [ctx.payer],
});

/** Job: end Instant Redeem orders that expired (their Gemas go back) and, when switched on, fill the oldest open ones. */
export async function orderJob(ctx: Ctx, d: OrderDeps = realOrderDeps(ctx)): Promise<number> {
  const rows = (await d.list("InstantOrderState")).map((r) => orderOf(r.pubkey, ctx.core.coder.accounts.decode("instantOrderState", r.data)));
  if (!rows.length) return 0;
  let actions = 0;
  for (const row of planExpiry(rows, ctx.now)) {
    const subject = `order=${shortKey(row.address)}`;
    const [sponsor] = await d.read.many([sponsorAddress]);
    const supply = await supplySources(ctx.core, d.read, [{ source: row.source, cut: false }]);
    const r = await act(ctx, "orders", subject, `expire_instant_redeem (${row.open} Gemas back to ${shortKey(row.account)})`, async () =>
      d.send([await expireInstantRedeemIx(ctx.core, { signer: ctx.payer.publicKey, ownerAccount: row.account, order: row.address, ownerWallet: row.payer, sponsor: sponsor ? sponsorAddress : null, remaining: supply.metas })], { units: 400_000 }),
    );
    actions += +r.ok;
  }
  actions += await fillOrders(ctx, d, rows);
  return actions;
}

async function fillOrders(ctx: Ctx, d: OrderDeps, rows: OrderRow[]): Promise<number> {
  const economy: any = await ctx.core.account.economyConfig.fetchNullable(economyAddress);
  if (!economy) return 0;
  const settings: FillSettings = { keeperFills: !!economy.keeperFills, fillKeeper: keyOf(economy.fillKeeper) };
  const filler = d.candidates().find((k): k is Keypair => !!k && k.publicKey.equals(settings.fillKeeper)) ?? null;
  const plan = planFills(rows, ctx.now, d.rule, settings, () => !!filler);
  if (!plan.length) return 0;
  let actions = 0;
  for (const { row, gemas } of plan) {
    const subject = `order=${shortKey(row.address)}`;
    const build = await fillBuilder(ctx, d, row, filler!);
    if (!build) {
      log("orders", subject, "SKIP the Source is not one the keeper can pay from (bridged Sources are filled by the bridge)");
      continue;
    }
    let chosen: { ixs: Parameters<typeof sendIxs>[2]; gemas: bigint } | null = null;
    for (const size of fillSizes(gemas)) {
      const ixs = await build(size);
      const why = await d.simulate(ixs);
      if (!why) {
        chosen = { ixs, gemas: size };
        break;
      }
      log("orders", subject, `wait: a fill of ${size} Gemas would fail (${why.slice(0, 120)})`);
    }
    if (!chosen) continue;
    const r = await act(ctx, "orders", subject, `fill_instant_redeem ${chosen.gemas} Gemas of ${row.open}`, () => d.send(chosen!.ixs, { units: 600_000, signers: filler!.publicKey.equals(ctx.payer.publicKey) ? [] : [filler!] }));
    actions += +r.ok;
  }
  return actions;
}

/** Builds `fill_instant_redeem` for an order of a Solana Source; null for any other. */
async function fillBuilder(ctx: Ctx, d: OrderDeps, row: OrderRow, filler: Keypair): Promise<((gemas: bigint) => Promise<Parameters<typeof sendIxs>[2]>) | null> {
  const [src] = await d.read.many([row.source]);
  if (!src) return null;
  const source: any = ctx.core.coder.accounts.decode("sourceState", src.data);
  const position = keyOf(source.inner.position);
  const [pos] = await d.read.many([position]);
  if (!pos) return null;
  const custody = await custodyOf(ctx.core, d.read, decodeCorePosition(ctx.core, pos.data), SIM_SOL_MINT);
  if (!custody) return null;
  const [treasury] = await d.read.many([pda("treasury")]);
  if (!treasury) return null;
  const vault = keyOf((ctx.core.coder.accounts.decode("treasury", treasury.data) as any).vault);
  const books = (await supplySources(ctx.core, d.read, [{ source: row.source, cut: false }])).metas;
  const [sponsor] = await d.read.many([sponsorAddress]);
  const remaining: AccountMeta[] = dedupe([...payingAccounts(custody, ata(row.owner, custody.mint)), ...(custody.kind === "native" ? [meta(vault)] : []), ...books]);
  return async (gemas) => [await fillInstantRedeemIx(ctx.core, { filler: filler.publicKey, order: row.address, ownerWallet: row.payer, position, source: row.source, gemas, remaining, sponsor: sponsor ? sponsorAddress : null })];
}
