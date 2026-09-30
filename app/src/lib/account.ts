import { holdings as mockHoldings, matches as mockMatches, positions as mockPositions } from "./mock";
import { useAuth } from "./auth/context";
import { useChainData } from "./chain/ChainDataProvider";
import type { AccountSnapshot, ChainMatch } from "./chain/read";
import { backerDelta, entryProblem, matchDelta, type EntryError } from "./chain/ledger";
import type { AuthState } from "./auth/types";
import type { Account, GemaHolding, Match, Position } from "./mock";

export interface AccountView {
  account: Account;
  /** Real session: sign-in state, embedded/linked wallets, sign-in gate. */
  auth: AuthState;
  positions: Position[];
  holdings: GemaHolding[];
  matches: Match[];
  /** Totals derived from holdings; never stored separately. */
  gemas: {
    total: number;
    redeemable: number;
    pending: number;
    /** Held back for Offers you posted: still yours, not spendable until the Offer is used or released. */
    reserved: number;
    /** `total - reserved`: what an entry can draw on now. */
    available: number;
  };
  /**
   * True when Positions, Gemas and Matches come from tesoro_core on Solana devnet. False means
   * MOCK data: only when there is no session to read for (signed out, or the app runs without Privy).
   */
  onChain: boolean;
  loading: boolean;
  /** This Account's Matches that are not finished yet (Open or Active), newest first. Empty when mock. */
  openMatches: ChainMatch[];
  /** The raw chain snapshot (null while loading or when mock). */
  snapshot: AccountSnapshot | null;
  /** Re-read the Account from chain now. */
  refresh: () => Promise<void>;
  /**
   * Why an entry of this size cannot be made from the Account's Holdings under tesoro_core's draw
   * rule (not enough Gemas, or more than 8 Sources needed), or null when it can. Always null when
   * the data is mock.
   */
  entryProblem: (entry: number) => EntryError["code"] | null;
}

export function redeemableOf(h: GemaHolding): number {
  return Math.round(h.gemas * h.accruedShare);
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

function fromSnapshot(s: AccountSnapshot) {
  const holdings: GemaHolding[] = s.holdings
    .filter((h) => h.amount > 0n)
    .map((h) => ({
      source: {
        positionId: h.position.toBase58(),
        chain: h.asset,
        asset: h.asset,
        owner: h.isOwn ? "Your Position" : `${short(h.sourceOwner)}'s Position`,
        advanceId: h.source.toBase58(),
      },
      gemas: Number(h.amount),
      accruedShare: Number(h.redeemable) / Number(h.amount),
      own: h.isOwn,
    }));
  const positions: Position[] = s.positions.map((p) => ({
    id: p.address.toBase58(),
    chain: p.asset,
    asset: p.asset,
    principal: p.principal,
    apy: p.apy,
    debt: p.debt,
    advance: p.advance && {
      id: p.advance.source.toBase58(),
      positionId: p.address.toBase58(),
      horizonMonths: p.advance.horizonMonths,
      gemasIssued: p.advance.gemasIssued,
      projectedYield: (p.principal * p.apy * p.advance.horizonMonths) / 12,
      issuedAt: "",
      // No accrual clock is on chain yet; the Wallet shows "estimated once yield accrues".
      unlockEstimate: "",
    },
  }));
  const settled = (m: ChainMatch) => m.status === "settled" || m.status === "refunded";
  const played: Match[] = s.matches.filter(settled).map((m) => {
      const draw = m.session?.result === "draw";
      const delta = matchDelta(m);
      return {
        id: m.id.toString(),
        game: m.game,
        entry: m.entry as Match["entry"],
        opponent: m.opponent ? short(m.opponent) : "no opponent",
        result: draw ? "draw" : m.status === "refunded" || (m.game === "block-puzzle" && !m.session) ? "refunded" : delta > 0 ? "won" : "lost",
        gemasDelta: delta,
        seed: m.session ? `0x${m.session.seed.toString(16).padStart(16, "0").slice(0, 4)}…${m.session.seed.toString(16).slice(-4)}` : "—",
        playedAt: new Date(Number(m.id >> 1n)).toISOString(),
        backed: m.backing !== null,
      };
    });
  // Matches this Account funded as a Backer: the entry was theirs, the result is the split (or the loss).
  const funded: Match[] = s.funded.filter(settled).map((m) => {
    const b = m.backing;
    const delta = b ? backerDelta({ ...m, backerSeat: b.seat, shareBps: b.shareBps }) : 0;
    const result = m.session ? (m.session.result === "draw" ? "draw" : delta > 0 ? "won" : "lost") : m.game === "holdem" && m.winner ? (delta > 0 ? "won" : "lost") : "refunded";
    return {
      id: m.id.toString(),
      game: m.game,
      entry: m.entry as Match["entry"],
      opponent: b ? `${short(b.player)} (you backed)` : "backed Player",
      result,
      gemasDelta: delta,
      seed: "—",
      playedAt: new Date(Number(m.id >> 1n)).toISOString(),
      backed: true,
    } satisfies Match;
  });
  const matches = [...played, ...funded].sort((x, y) => (x.playedAt < y.playedAt ? 1 : -1));
  const openMatches = s.matches.filter((m) => m.status === "open" || m.status === "active");
  return { holdings, positions, matches, openMatches };
}

/**
 * The single seam for Account data. Identity comes from the Privy session (or the dev wallet).
 * When signed in, Positions, Gemas and Matches are read from tesoro_core on devnet. Mock data is
 * used only where there is no session to read for.
 */
export function useAccount(): AccountView {
  const auth = useAuth();
  const chain = useChainData();
  const onChain = auth.status === "signed-in";

  const real = chain.snapshot ? fromSnapshot(chain.snapshot) : null;
  const holdings = onChain ? (real?.holdings ?? []) : mockHoldings;
  const total = holdings.reduce((s, h) => s + h.gemas, 0);
  const reserved = onChain ? (chain.snapshot?.holdings.reduce((s, h) => s + Number(h.reserved), 0) ?? 0) : 0;
  const redeemable = holdings.reduce((s, h) => s + redeemableOf(h), 0);
  const account: Account = {
    id: auth.email ?? "guest",
    displayName: auth.email?.split("@")[0] ?? "Guest",
    addresses: auth.addresses,
  };
  return {
    account,
    auth,
    positions: onChain ? (real?.positions ?? []) : mockPositions,
    holdings,
    matches: onChain ? (real?.matches ?? []) : mockMatches,
    gemas: { total, redeemable, pending: total - redeemable, reserved, available: total - reserved },
    onChain,
    loading: onChain && chain.loading,
    openMatches: real?.openMatches ?? [],
    snapshot: chain.snapshot,
    refresh: chain.refresh,
    entryProblem: (entry) =>
      onChain && chain.snapshot
        ? entryProblem(
            BigInt(entry),
            chain.snapshot.holdings.map((h) => ({ source: h.source.toBytes(), isOwn: h.isOwn, free: h.free })),
          )
        : null,
  };
}
