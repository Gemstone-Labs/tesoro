import { BN } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { debtGemas, debtUnits, instantSplit, redeemableFor, type SourceMath } from "./ledger";
import { SIM_SOL_MINT, TESORO_CORE_ID, custodyPda, marketFrom, marketKeys, nativeInfoFrom, vaultPda, type NativeInfo } from "./native";
import { parseEthPositionId } from "./eth";
import type { AccountSnapshot, ChainAdvance, ChainHolding, ChainPosition } from "./read";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());
const enumKey = (o: object) => Object.keys(o)[0];
const ASSETS = ["SOL", "ETH", "HYPE"] as const;

type Info = AccountInfo<Buffer> | null;
type Row = { publicKey: PublicKey; account: any };

/** Where an Account's state is read from: the browser (its own connection) or the server route (cached lists, its own connection). */
export interface StateSource {
  /** Every Holding and Position of one TesoroAccount, decoded. List reads may lag the chain. */
  lists(accountKey: PublicKey): Promise<[Row[], Row[]]>;
  /** Raw accounts in key order, null where missing. At most 100 keys. */
  infos(keys: PublicKey[]): Promise<Info[]>;
  balance(authority: PublicKey): Promise<number>;
  /** Decodes a tesoro_core account by IDL name; throws on a layout it does not know. */
  decode(name: "tesoroAccount" | "sourceState" | "holdingState" | "positionState", data: Buffer): any;
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

function sourceMath(inner: any): SourceMath {
  return {
    issued: big(inner.issued),
    returned: big(inner.returned),
    redeemed: big(inner.redeemed),
    yieldUnits: big(inner.yieldUnits),
    unitNum: big(inner.unitNum),
    unitDen: big(inner.unitDen),
  };
}

const isNativePosition = (pos: any) => !!pos && pk(pos.inner.sourceAsset).equals(SIM_SOL_MINT) && enumKey(pos.inner.sourceChain) === "solana";

/**
 * The Account without its Matches (`matchesLoaded` false): SOL, Gemas, Positions and the simSOL market.
 * Rounds of reads, each batching everything the previous one made known: (1) the lists, the Account, the
 * market and the balance; (2) every Holding, Source and Position of the Account with its custody and vault;
 * (3) only when held Gemas come from other Accounts' Positions, those Positions with their custody and vault.
 */
export async function readAccountState(src: StateSource, authority: PublicKey, accountKey: PublicKey): Promise<AccountSnapshot> {
  const lists = src.lists(accountKey);
  lists.catch(() => undefined);
  const [accountAndMarket, lamports] = await Promise.all([src.infos([accountKey, ...marketKeys(authority)]), src.balance(authority).catch(() => 0)]);
  const [accountInfo, ...marketInfos] = accountAndMarket;
  let market = null;
  try {
    market = marketFrom(marketInfos);
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
    holdings: [],
    positions: [],
    matches: [],
    matchesLoaded: false,
    market,
    funded: [],
    fetchedAt: Date.now(),
  };
  if (!acct) return empty;
  const [holdingRows, listedPositions] = await lists;

  // The list route may answer from its cache (up to 2 min old): re-read every Holding and Position of the list so amounts and states are current.
  const heldSources = holdingRows.map((h) => pk(h.account.inner.source));
  const withAdvance = listedPositions.filter((r) => r.account.inner.openAdvance !== null && r.account.inner.openAdvance !== undefined);
  const listedNative = listedPositions.filter((r) => isNativePosition(r.account));
  const read = batch(src);
  const wanted = [
    ...holdingRows.map((r) => r.publicKey),
    ...heldSources,
    ...listedPositions.map((r) => r.publicKey),
    ...withAdvance.map((r) => sourceOf(r.publicKey, r.account.inner.openAdvance)),
    ...listedNative.flatMap((r) => [custodyPda(r.publicKey), vaultPda(r.publicKey)]),
    ...listedNative.filter((r) => r.account.inner.advances > 0).map((r) => sourceOf(r.publicKey, r.account.inner.advances - 1)),
  ];
  await read.load(wanted);

  const sources = heldSources.map((k) => decodeOr(src, "sourceState", read.get(k)));
  const freshHoldings = holdingRows.map((r) => decodeOr(src, "holdingState", read.get(r.publicKey)));
  const openSources = withAdvance.map((r) => decodeOr(src, "sourceState", read.get(sourceOf(r.publicKey, r.account.inner.openAdvance))));
  const positionRows: Row[] = listedPositions.map((r) => ({ publicKey: r.publicKey, account: decodeOr(src, "positionState", read.get(r.publicKey)) ?? r.account }));
  const ownNative = positionRows.filter((r) => isNativePosition(r.account));
  // A Position that moved on since the list (a new Advance) has a different latest Source: read it too.
  await read.load(ownNative.filter((r) => r.account.inner.advances > 0).map((r) => sourceOf(r.publicKey, r.account.inner.advances - 1)));
  await read.load(ownNative.flatMap((r) => [custodyPda(r.publicKey), vaultPda(r.publicKey)]));

  // Positions behind Gemas won or backed from other Accounts: read them with their native custody and vault in one batch.
  const positionByKey = new Map<string, any>(positionRows.map((r) => [r.publicKey.toBase58(), r.account]));
  const foreign = [...new Map<string, PublicKey>(sources.filter(Boolean).map((s: any) => [pk(s.inner.position).toBase58(), pk(s.inner.position)])).entries()]
    .filter(([k]) => !positionByKey.has(k))
    .map(([, key]) => key);
  await read.load(foreign.flatMap((p) => [p, custodyPda(p), vaultPda(p)]));
  const nativeKeys = new Set<string>();
  for (const key of foreign) {
    const decoded = decodeOr(src, "positionState", read.get(key));
    positionByKey.set(key.toBase58(), decoded);
    if (isNativePosition(decoded) && read.get(custodyPda(key)) && read.get(vaultPda(key))) nativeKeys.add(key.toBase58());
  }
  const ownInfo = new Map<string, NativeInfo | null>();
  for (const r of ownNative) {
    const advances: number = r.account.inner.advances;
    const [pos, cust, vault] = [read.get(r.publicKey), read.get(custodyPda(r.publicKey)), read.get(vaultPda(r.publicKey))];
    const latest = advances > 0 ? read.get(sourceOf(r.publicKey, advances - 1)) : null;
    let info: NativeInfo | null = null;
    if (pos && cust && vault) {
      try {
        info = nativeInfoFrom(r.publicKey, pos, cust, vault, latest);
      } catch {
        info = null;
      }
    }
    ownInfo.set(r.publicKey.toBase58(), info);
    if (info) nativeKeys.add(r.publicKey.toBase58());
  }

  const holdings: ChainHolding[] = [];
  holdingRows.forEach((row, i) => {
    const source: any = sources[i];
    if (!source) return;
    const h = (freshHoldings[i] ?? row.account).inner;
    const amount = big(h.amount);
    const reserved = big(h.reserved);
    const free = amount - reserved;
    const pos = positionByKey.get(pk(source.inner.position).toBase58());
    const math = sourceMath(source.inner);
    const native = nativeKeys.has(pk(source.inner.position).toBase58());
    const redeemable = redeemableFor(math, free);
    holdings.push({
      holding: row.publicKey,
      source: heldSources[i],
      position: pk(source.inner.position),
      isOwn: h.isOwn,
      amount,
      reserved,
      free,
      redeemable,
      pending: h.isOwn ? 0n : native ? instantSplit(math, free).pending : free - redeemable,
      sourceDebt: debtGemas(math),
      unitNum: big(source.inner.unitNum),
      unitDen: big(source.inner.unitDen),
      sourceOwner: pk(source.inner.owner).toBase58(),
      native,
      eth: pos && ["ethereum", "hyperEvm"].includes(enumKey(pos.inner.sourceChain)) ? parseEthPositionId(Uint8Array.from(pos.positionId)) : null,
      asset: ASSETS[pos ? ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(pos.inner.sourceChain)) : 0] ?? "SOL",
    });
  });

  const openSourceOf = new Map<string, any>(withAdvance.map((r, i) => [r.publicKey.toBase58(), openSources[i]]));
  const positions: ChainPosition[] = positionRows.map((row) => {
    const p = row.account.inner;
    const chainIdx = ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(p.sourceChain));
    const decimals = 10 ** p.decimals;
    let advance: ChainAdvance | null = null;
    let debt = 0;
    const open: any = openSourceOf.get(row.publicKey.toBase58());
    if (open) {
      const m = sourceMath(open.inner);
      advance = {
        source: sourceOf(row.publicKey, p.openAdvance),
        gemasIssued: Number(m.issued),
        horizonMonths: open.inner.horizonMonths,
        debtGemas: Number(debtGemas(m)),
      };
      debt = Number(debtUnits(m)) / decimals;
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
      yieldAccrued: Number(big(p.cumulativeYield)) / decimals,
      native: ownInfo.get(row.publicKey.toBase58()) ?? null,
      eth: chainIdx >= 1 ? parseEthPositionId(Uint8Array.from(row.account.positionId)) : null,
    };
  });

  return { ...empty, exists: true, ownTotal: big(acct.inner.ownTotal), wonTotal: big(acct.inner.wonTotal), holdings, positions };
}

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
