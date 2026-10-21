import { holdings as mockHoldings, matches as mockMatches, positions as mockPositions } from "./mock";
import { useAuth } from "./auth/context";
import { useChainData } from "./chain/ChainDataProvider";
import type { AccountSnapshot, ChainMatch } from "./chain/read";
import { accountHistory } from "./chain/history";
import type { EntryError } from "./chain/ledger";
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
  /** True once `gemas` are real figures (mock data, or the chain snapshot has been read); false while sign-in or the first read is pending. */
  ready: boolean;
  /** Why the last chain read failed, while no snapshot is shown; null otherwise. */
  error: string | null;
  /** This Account's Matches that are not finished yet (Open or Active), newest first. Empty when mock. */
  openMatches: ChainMatch[];
  /** The raw chain snapshot (null while loading or when mock). */
  snapshot: AccountSnapshot | null;
  /** Re-read the Account from chain now. Resolves false when the read failed. */
  refresh: () => Promise<boolean>;
  /**
   * Why an entry of this size cannot be made from the Account's Holdings under tesoro_core's draw
   * rule (not enough free Gemas), or null when it can. Always null when
   * the data is mock.
   */
  entryProblem: (entry: number) => EntryError["code"] | null;
}

export function redeemableOf(h: GemaHolding): number {
  return Math.round(h.gemas * h.accruedShare);
}

export interface PendingSource {
  /** The Source (Advance) id. */
  key: string;
  chain: GemaHolding["source"]["chain"];
  asset: GemaHolding["source"]["asset"];
  positionId: string;
  /** Whose Position, e.g. "Your Lock". */
  owner: string;
  pending: number;
  /** Share of the Source's yield accrued so far (0..1). */
  accruedShare: number;
}

/** Pending Gemas per Source (asset + Position), largest first. Sources with nothing pending are left out. */
export function pendingBySource(holdings: GemaHolding[]): PendingSource[] {
  const bySource = new Map<string, PendingSource>();
  for (const h of holdings) {
    const pending = h.gemas - redeemableOf(h);
    if (pending <= 0) continue;
    const cur = bySource.get(h.source.advanceId);
    if (cur) cur.pending += pending;
    else
      bySource.set(h.source.advanceId, {
        key: h.source.advanceId,
        chain: h.source.chain,
        asset: h.source.asset,
        positionId: h.source.positionId,
        owner: h.source.owner,
        pending,
        accruedShare: h.accruedShare,
      });
  }
  return [...bySource.values()].sort((a, b) => b.pending - a.pending);
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

function fromSnapshot(s: AccountSnapshot) {
  const holdings: GemaHolding[] = s.holdings
    // fee-class lines (an outside Studio's fee) are not Gemas the Player can enter with
    .filter((h) => h.amount > 0n && h.classId >= 3)
    .map((h) => ({
      source: {
        positionId: h.position.toBase58(),
        chain: h.asset,
        asset: h.asset,
        owner: h.isOwn ? "Your Lock" : `${short(h.sourceOwner)}'s Lock`,
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
  const byId = new Map([...s.matches, ...s.funded].map((m) => [m.id.toString(), m]));
  const matches: Match[] = accountHistory(s.matches, s.funded).map((r) => {
    const m = byId.get(r.id);
    const seed = m?.session && r.role === "player" ? m.session.seed.toString(16).padStart(16, "0") : null;
    return {
      id: r.id,
      game: r.game,
      entry: r.entry as Match["entry"],
      opponent: r.role === "backer" && r.backing ? `${short(r.backing.other)} (you backed)` : r.opp ? short(r.opp) : "no opponent",
      result: r.result,
      gemasDelta: r.delta,
      seed: seed ? `0x${seed.slice(0, 4)}…${seed.slice(-4)}` : "—",
      playedAt: new Date(r.at).toISOString(),
      backed: r.backing !== null,
    } satisfies Match;
  });
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
  // Mock data only where there is no session to read for: never while Privy is still deciding.
  const mock = auth.status === "signed-out" || auth.status === "unconfigured";

  const real = chain.snapshot ? fromSnapshot(chain.snapshot) : null;
  const holdings = mock ? mockHoldings : (real?.holdings ?? []);
  const total = holdings.reduce((s, h) => s + h.gemas, 0);
  const reserved = onChain ? Number((chain.snapshot?.reservedTotal ?? 0n) + (chain.snapshot?.ticketNeed ?? 0n)) : 0;
  const redeemable = holdings.reduce((s, h) => s + redeemableOf(h), 0);
  const account: Account = {
    id: auth.email ?? "guest",
    displayName: auth.email?.split("@")[0] ?? "Guest",
    addresses: auth.addresses,
  };
  return {
    account,
    auth,
    positions: mock ? mockPositions : (real?.positions ?? []),
    holdings,
    matches: mock ? mockMatches : (real?.matches ?? []),
    gemas: { total, redeemable, pending: total - redeemable, reserved, available: total - reserved },
    onChain,
    loading: auth.status === "loading" || (onChain && (chain.loading || !auth.addresses.solana)),
    ready: mock || (onChain && chain.snapshot !== null),
    error: onChain && !chain.snapshot ? chain.error : null,
    openMatches: real?.openMatches ?? [],
    snapshot: chain.snapshot,
    refresh: chain.refresh,
    entryProblem: (entry) => {
      const snap = chain.snapshot;
      if (!onChain || !snap) return null;
      // Same rule as the program: playable Gemas minus Offer reservations minus what an open Ticket still has to stage.
      const free = snap.ownTotal + snap.wonTotal - snap.reservedTotal - snap.ticketNeed;
      return BigInt(entry) > free ? "insufficient" : null;
    },
  };
}
