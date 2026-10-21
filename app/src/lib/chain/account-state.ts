import { BN } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { CLUSTER } from "../cluster-settings";
import { basketPda, decodeStore, lineRefOf, mergedLines, spillPda, bookPda, CLASS_GENERAL, SIDE_OWN, type Line, type Store } from "./basket";
import { debtGemasOf, decodeBook, fpFloor, readyNow, syncPreview, type SourceBookView } from "./book";
import { bookAccounts } from "./draw";
import { SIM_SOL_MINT, TESORO_CORE_ID, marketFrom, marketKeys, nativeInfoFrom, nativeNow, speedupOf, stakeGrowthOf, type NativeInfo } from "./native";
import { stakeMarketFrom, stakeMarketKeys } from "./stake";
import { positionAccrued } from "./yield";
import { clockOf } from "./native";
import { parseEthPositionId } from "./eth";
import type { AccountSnapshot, ChainAdvance, ChainHolding, ChainPosition, StoreSummary } from "./read";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());
const enumKey = (o: object) => Object.keys(o)[0];
const REAL = CLUSTER.yieldModel === "real";
const ASSETS = ["SOL", "ETH", "HYPE"] as const;

type Info = AccountInfo<Buffer> | null;
type Row = { publicKey: PublicKey; account: any };

/** Where an Account's state is read from: the browser (its own connection) or the server route (cached lists, its own connection). */
export interface StateSource {
  /** Every Position of one TesoroAccount, decoded. List reads may lag the chain. */
  lists(accountKey: PublicKey): Promise<Row[]>;
  /** Raw accounts in key order, null where missing. At most 100 keys. */
  infos(keys: PublicKey[]): Promise<Info[]>;
  balance(authority: PublicKey): Promise<number>;
  /** Decodes a tesoro_core account by IDL name; throws on a layout it does not know. */
  decode(name: "tesoroAccount" | "sourceState" | "positionState", data: Buffer): any;
}

const decodeOr = (src: StateSource, name: Parameters<StateSource["decode"]>[0], info: Info) => {
  if (!info) return null;
  try {
    return src.decode(name, info.data);
  } catch {
    return null;
  }
};

const sourceOf = (position: PublicKey, index: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("source"), position.toBuffer(), new BN(index).toArrayLike(Buffer, "le", 4)], TESORO_CORE_ID)[0];

/** A Solana Position whose yield the program computes from the clock: simSOL custody, or a staking token (marked by the pool's rate at open). */
const isNativePosition = (pos: any) =>
  !!pos && enumKey(pos.inner.sourceChain) === "solana" && (pk(pos.inner.sourceAsset).equals(SIM_SOL_MINT) || big(pos.inner.stakeRateOpen ?? 0) !== 0n);

const summary = (st: Store | null): StoreSummary => ({
  len: st?.header.len ?? 0,
  capacity: st?.header.capacity ?? 0,
  roomReserved: st?.header.roomReserved ?? 0,
  flags: st?.header.flags ?? 0,
  sponsoredLamports: st?.header.sponsoredLamports ?? 0n,
});

const readStore = (info: Info): Store | null => {
  if (!info) return null;
  try {
    return decodeStore(info.data);
  } catch {
    return null;
  }
};

/** The coverage a Source's open Advance has earned by the clock and not yet landed, for the Redeem / Debt preview. Null when nothing is derived (reported or closed Sources are as stored). */
function syncedBook(book: SourceBookView, pos: any, srcState: any, speedup: number, nowSec: number, stake: ReturnType<typeof stakeGrowthOf>): SourceBookView {
  if (!isNativePosition(pos) || pos.inner.openAdvance !== srcState.inner.index || enumKey(pos.inner.status) !== "locked") return book;
  const p = pos.inner;
  const clock = clockOf({ principalLamports: big(p.principal), rateBps: p.rateBps, yieldFeeBps: p.yieldFeeBps, openedAt: Number(big(p.openedAt)), stakeRateOpen: big(p.stakeRateOpen ?? 0) });
  const net = positionAccrued(clock, speedup, nowSec, stake).net;
  const applied = big(p.appliedNet);
  const counted = net > applied ? net - applied : 0n;
  return syncPreview(book, counted, { unitNum: big(srcState.inner.unitNum), unitDen: big(srcState.inner.unitDen) });
}

/**
 * The Account without its Matches (`matchesLoaded` false): SOL, Gemas, Positions and the simSOL market.
 * Rounds of reads, each batching everything the previous one made known: (1) the Account, its basket and
 * spill, the market, the balance and the Position list; (2) every Source the lines come from with its book,
 * the Positions and Sources of own Advances; (3) only when held Gemas come from other Accounts' Positions, those Positions.
 * Native Positions need no other account: their Debt is the Source book with the clock's coverage landed.
 */
export async function readAccountState(src: StateSource, authority: PublicKey, accountKey: PublicKey): Promise<AccountSnapshot> {
  const lists = src.lists(accountKey);
  lists.catch(() => undefined);
  const [accountAndMarket, lamports] = await Promise.all([
    src.infos([accountKey, basketPda(accountKey), spillPda(accountKey), ...(REAL ? stakeMarketKeys(authority) : marketKeys(authority))]),
    src.balance(authority).catch(() => 0),
  ]);
  const [accountInfo, basketInfo, spillInfo, ...marketInfos] = accountAndMarket;
  let market = null;
  try {
    market = REAL ? stakeMarketFrom(marketInfos) : marketFrom(marketInfos);
  } catch (e) {
    console.warn("native market", e);
  }
  const acct = decodeOr(src, "tesoroAccount", accountInfo);
  const empty: AccountSnapshot = {
    exists: false,
    accountKey,
    lamports,
    ownTotal: 0n,
    wonTotal: 0n,
    reservedTotal: 0n,
    ticketNeed: 0n,
    feeTotal: 0n,
    stores: null,
    holdings: [],
    positions: [],
    matches: [],
    matchesLoaded: false,
    market,
    funded: [],
    fetchedAt: Date.now(),
  };
  if (!acct) return empty;
  const basket = readStore(basketInfo);
  const spill = readStore(spillInfo);
  const listedPositions = await lists;
  const lines = mergedLines(basket ?? { header: summaryHeader(), lines: [] }, spill);
  const inSpill = new Set((spill?.lines ?? []).map(keyOf));

  const heldSources = [...new Map(lines.map((l) => [l.source.toBase58(), l.source])).values()];
  const withAdvance = listedPositions.filter((r) => r.account.inner.openAdvance !== null && r.account.inner.openAdvance !== undefined);
  const listedNative = listedPositions.filter((r) => isNativePosition(r.account));
  const read = batch(src);
  const wanted = [
    ...heldSources,
    ...heldSources.map(bookPda),
    ...listedPositions.map((r) => r.publicKey),
    ...withAdvance.flatMap((r) => [sourceOf(r.publicKey, r.account.inner.openAdvance), bookPda(sourceOf(r.publicKey, r.account.inner.openAdvance))]),
    ...listedNative.filter((r) => r.account.inner.advances > 0).map((r) => sourceOf(r.publicKey, r.account.inner.advances - 1)),
  ];
  await read.load(wanted);

  const sourceStates = new Map(heldSources.map((k) => [k.toBase58(), decodeOr(src, "sourceState", read.get(k))]));
  const books = new Map<string, SourceBookView | null>();
  const bookOf = (source: PublicKey) => {
    const id = source.toBase58();
    if (!books.has(id)) {
      const info = read.get(bookPda(source));
      let view: SourceBookView | null = null;
      try {
        view = info ? decodeBook(info.data) : null;
      } catch {
        view = null;
      }
      books.set(id, view);
    }
    return books.get(id) ?? null;
  };
  const openSources = withAdvance.map((r) => decodeOr(src, "sourceState", read.get(sourceOf(r.publicKey, r.account.inner.openAdvance))));
  const positionRows: Row[] = listedPositions.map((r) => ({ publicKey: r.publicKey, account: decodeOr(src, "positionState", read.get(r.publicKey)) ?? r.account }));
  const ownNative = positionRows.filter((r) => isNativePosition(r.account));
  // Only a Position that moved on since the list (a new Advance) has a latest Source that the first batch lacks: that read is the only extra round, and it is empty when nothing moved.
  const moved = read.load(ownNative.filter((r) => r.account.inner.advances > 0).map((r) => sourceOf(r.publicKey, r.account.inner.advances - 1)));

  // Positions behind Gemas won or backed from other Accounts: read them in one batch.
  const positionByKey = new Map<string, any>(positionRows.map((r) => [r.publicKey.toBase58(), r.account]));
  const foreign = [...new Map<string, PublicKey>([...sourceStates.values()].filter(Boolean).map((s: any) => [pk(s.inner.position).toBase58(), pk(s.inner.position)])).entries()]
    .filter(([k]) => !positionByKey.has(k))
    .map(([, key]) => key);
  await Promise.all([moved, read.load(foreign)]);
  const nativeKeys = new Set<string>();
  for (const key of foreign) {
    const decoded = decodeOr(src, "positionState", read.get(key));
    positionByKey.set(key.toBase58(), decoded);
    if (isNativePosition(decoded)) nativeKeys.add(key.toBase58());
  }
  const ownInfo = new Map<string, NativeInfo | null>();
  for (const r of ownNative) {
    const advances: number = r.account.inner.advances;
    const pos = read.get(r.publicKey);
    const latest = advances > 0 ? read.get(sourceOf(r.publicKey, advances - 1)) : null;
    let info: NativeInfo | null = null;
    if (pos) {
      try {
        info = nativeInfoFrom(r.publicKey, pos, latest);
      } catch {
        info = null;
      }
    }
    ownInfo.set(r.publicKey.toBase58(), info);
    if (info) nativeKeys.add(r.publicKey.toBase58());
  }

  const speedup = speedupOf(market?.pool);
  const nowSec = Math.floor(Date.now() / 1000);
  const stake = stakeGrowthOf(market, nowSec);
  const syncedOf = (source: PublicKey, state: any, pos: any): SourceBookView | null => {
    const book = bookOf(source);
    return book && pos ? syncedBook(book, pos, state, speedup, nowSec, stake) : book;
  };

  const holdings: ChainHolding[] = [];
  for (const line of lines) {
    const state: any = sourceStates.get(line.source.toBase58());
    if (!state) continue;
    const position = pk(state.inner.position);
    const pos = positionByKey.get(position.toBase58());
    const book = syncedOf(line.source, state, pos);
    if (!book) continue;
    let ready = 0n;
    try {
      ready = fpFloor(readyNow(book, line));
    } catch {
      continue;
    }
    const isOwn = line.side === SIDE_OWN;
    const chainIdx = pos ? ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(pos.inner.sourceChain)) : 0;
    const native = nativeKeys.has(position.toBase58());
    holdings.push({
      key: keyOf(line),
      line: lineRefOf(line),
      store: inSpill.has(keyOf(line)) ? "spill" : "basket",
      source: line.source,
      position,
      isOwn,
      classId: line.classId,
      tranche: line.tranche,
      dueAt: Number(line.dueAt),
      amount: line.amount,
      reserved: 0n,
      free: line.amount,
      redeemable: ready,
      pending: isOwn ? 0n : line.amount - ready,
      sourceDebt: debtGemasOf(book),
      unitNum: big(state.inner.unitNum),
      unitDen: big(state.inner.unitDen),
      sourceOwner: pk(state.inner.owner).toBase58(),
      native,
      stakeMint: native && big(pos?.inner.stakeRateOpen ?? 0) !== 0n ? pk(pos.inner.sourceAsset) : null,
      eth: pos && ["ethereum", "hyperEvm"].includes(enumKey(pos.inner.sourceChain)) ? parseEthPositionId(Uint8Array.from(pos.positionId)) : null,
      asset: ASSETS[chainIdx] ?? "SOL",
      sourceIndex: state.inner.index,
      open: pos?.inner.openAdvance === state.inner.index,
      accounts: bookAccounts(line.source, [line], (c) => book.classes[c]?.ck ?? 0),
    });
  }

  const openSourceOf = new Map<string, any>(withAdvance.map((r, i) => [r.publicKey.toBase58(), openSources[i]]));
  const positions: ChainPosition[] = positionRows.map((row) => {
    const p = row.account.inner;
    const chainIdx = ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(p.sourceChain));
    const decimals = 10 ** p.decimals;
    let advance: ChainAdvance | null = null;
    let debt = 0;
    const open: any = openSourceOf.get(row.publicKey.toBase58());
    const native = ownInfo.get(row.publicKey.toBase58()) ?? null;
    if (open) {
      const sourceKey = sourceOf(row.publicKey, p.openAdvance);
      const rawBook = bookOf(sourceKey);
      const book = rawBook ? syncedBook(rawBook, row.account, open, speedup, nowSec, stake) : null;
      const debtG = book ? debtGemasOf(book) : 0n;
      advance = {
        source: sourceKey,
        gemasIssued: Number(big(open.inner.issued)),
        horizonMonths: open.inner.horizonMonths,
        debtGemas: Number(debtG),
      };
      const num = big(open.inner.unitNum);
      const den = big(open.inner.unitDen);
      debt = den === 0n ? 0 : Number((debtG * num + den - 1n) / den) / decimals;
    }
    return {
      address: row.publicKey,
      asset: ASSETS[chainIdx] ?? "SOL",
      principal: Number(big(p.principal)) / decimals,
      apy: p.rateBps / 10_000,
      status: enumKey(p.status) as "locked" | "unlocked",
      advances: p.advances,
      advance,
      debt,
      yieldAccrued: Number(native ? nativeNow(native, speedup, nowSec, stake).accrued : big(p.cumulativeYield)) / decimals,
      native,
      eth: chainIdx >= 1 ? parseEthPositionId(Uint8Array.from(row.account.positionId)) : null,
    };
  });

  return {
    ...empty,
    exists: true,
    ownTotal: (basket?.header.ownTotal ?? 0n) + (spill?.header.ownTotal ?? 0n),
    wonTotal: (basket?.header.wonTotal ?? 0n) + (spill?.header.wonTotal ?? 0n),
    reservedTotal: basket?.header.reservedTotal ?? 0n,
    ticketNeed: basket?.header.ticketNeed ?? 0n,
    feeTotal: (basket?.header.feeTotal ?? 0n) + (spill?.header.feeTotal ?? 0n),
    stores: { basket: summary(basket), spill: summary(spill) },
    holdings,
    positions,
  };
}

const keyOf = (l: Line) => `${l.side}:${l.dueAt}:${l.source.toBase58()}:${l.classId}:${l.tranche}`;
const summaryHeader = (): Store["header"] => ({ version: 3, bump: 0, flags: 0, len: 0, first: 0, account: PublicKey.default, ownTotal: 0n, wonTotal: 0n, feeTotal: 0n, reservedTotal: 0n, sponsoredLamports: 0n, ticketNeed: 0n, roomReserved: 0, capacity: 0 });

/** Raw accounts by key, 100 keys per request (the getMultipleAccounts limit), requests in parallel; a key is read once. */
function batch(src: StateSource) {
  const seen = new Map<string, Info>();
  return {
    async load(keys: PublicKey[]) {
      const todo = [...new Map(keys.filter((k) => !seen.has(k.toBase58())).map((k) => [k.toBase58(), k])).values()];
      const chunks: PublicKey[][] = [];
      for (let i = 0; i < todo.length; i += 100) chunks.push(todo.slice(i, i + 100));
      const got = (await Promise.all(chunks.map((c) => src.infos(c)))).flat();
      todo.forEach((k, i) => seen.set(k.toBase58(), got[i] ?? null));
    },
    get: (key: PublicKey): Info => seen.get(key.toBase58()) ?? null,
  };
}
