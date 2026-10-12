import type { CrossChainStep } from "@/components/ui/money";
import { LZ_SCAN_API, netOfVault, vaultByAddress, type EthState, type VaultPosition } from "./eth";

/**
 * Cross-chain operations on an ETH or HYPE Position that take minutes: open (EVM chain to Solana), report yield
 * (EVM chain to Solana), redeem and unlock (Solana to the EVM chain). Each is tracked from chain state, never from
 * a timer, so pending never shows success early and a reload picks up where it was. An Instant Redeem ("instant") is
 * tracked like a redeem, against the holder's Instant Claim.
 */
export type EthOpKind = "open" | "yield" | "redeem" | "instant" | "unlock";

export interface EthOp {
  key: string;
  kind: EthOpKind;
  vault: string;
  /** The vault's uint64 position id, as a decimal string. */
  id: string;
  createdAt: number;
  /** Months of the Advance an `open` takes once the Position exists. */
  months?: number;
  /** EVM tx hash (open, yield) or Solana signature (redeem, unlock) that started it. */
  hash?: string;
  /** Solana signature of the relayed send (redeem, unlock) or of the last relay step. */
  sendSig?: string;
  /** `yield`: the bridge's last received yield seq before the report. `redeem`, `instant`: the Claim's `units_total` after the Solana step (units that must be sent), decimal. */
  baseline?: string;
  /** `redeem`, `instant`: the Advance index of the redeemed Source; the Claim read, relayed and tracked is the one for it. */
  sourceIndex?: number;
  /** `redeem`, `instant`: Source units this redemption added to the Claim, decimal. */
  units?: string;
  /** `redeem`, `instant`: EVM block before the redemption; the payout is searched from here. Decimal. */
  fromBlock?: string;
  done?: boolean;
}

export type OpAction = "apply-locked" | "advance" | "apply-yield" | "send-pay-yield" | "send-pay-instant" | "send-unlock";

/** The chain-specific words of a tracker: the vault's network, its native token and its simulated token. */
export function opWords(vault: string) {
  const net = netOfVault(vault);
  const symbol = vaultByAddress(vault)?.symbol ?? (net.native === "HYPE" ? "simHYPE" : "simETH");
  return { net: net.label, native: net.native, symbol };
}

export const opSteps = (kind: EthOpKind, vault: string): CrossChainStep[] => {
  const w = opWords(vault);
  return {
    open: [
      { title: `${w.net} confirmed`, note: `Your Position is open on ${w.net}` },
      { title: "Reached Solana", note: "Tesoro received your Position" },
      { title: "Position recorded", note: "Added to your Account" },
      { title: "Advance taken", note: "At today’s price, for your Horizon" },
      { title: "Gemas available", note: "Gemas credited to your Account" },
    ],
    yield: [
      { title: `${w.net} confirmed`, note: `Yield report sent from ${w.net}` },
      { title: "Reached Solana", note: "Tesoro received the yield report" },
      { title: "Debt updated", note: "The yield paid down your Debt" },
    ],
    redeem: [
      { title: "Redeemed", note: "Your Gemas are exchanged and the payout is recorded" },
      { title: `On its way to ${w.net}`, note: "The payout is crossing chains" },
      { title: `${w.symbol} on ${w.net}`, note: "Paid to your wallet" },
    ],
    instant: [
      { title: "Sold to Tesoro", note: "Your Gemas are exchanged and the payout is recorded" },
      { title: `On its way to ${w.net}`, note: "The payout is crossing chains" },
      { title: `${w.symbol} on ${w.net}`, note: "Paid to your wallet" },
    ],
    unlock: [
      { title: "Unlocked", note: "Debt is zero; the Position is unlocked" },
      { title: `On its way to ${w.net}`, note: "The unlock is crossing chains" },
      { title: `Principal on ${w.net}`, note: "Your Principal is back in your wallet" },
    ],
  }[kind];
};

/** Copy per kind; Gemas only "become available" on open. */
export const opCopy = (kind: EthOpKind, vault: string): { label: string; finalState: string; done: string; pending: string; failed: string } => {
  const w = opWords(vault);
  return {
    open: {
      label: `${w.native} → Gemas`,
      finalState: "Available",
      done: "Gemas available. They are yours to play.",
      pending: "Pending. These Gemas are not available until the last step completes.",
      failed: "This step failed. Your Gemas are not available; nothing was spent.",
    },
    yield: {
      label: "Report yield",
      finalState: "Updated",
      done: `Debt updated from the yield accrued on ${w.net}.`,
      pending: "Pending. Debt only falls once the report arrives.",
      failed: "This step failed. Debt is unchanged.",
    },
    redeem: {
      label: `Redeem → ${w.net}`,
      finalState: "Paid",
      done: `${w.symbol} arrived on ${w.net}.`,
      pending: `Pending. The ${w.symbol} is not in your wallet until the last step completes.`,
      failed: "This step failed. Your redemption is recorded and can be retried.",
    },
    instant: {
      label: `Redeem now → ${w.net}`,
      finalState: "Paid",
      done: `${w.symbol} arrived on ${w.net}.`,
      pending: `Pending. The ${w.symbol} is not in your wallet until the last step completes.`,
      failed: "This step failed. Your Instant Redeem is recorded and can be retried.",
    },
    unlock: {
      label: `Unlock → ${w.net}`,
      finalState: "Returned",
      done: `Principal is back on ${w.net}.`,
      pending: "Pending. The Principal is not back until the last step completes.",
      failed: "This step failed. The Position is unlocked and the transfer can be retried.",
    },
  }[kind];
};

export interface OpProgress {
  /** Steps completed. */
  stage: number;
  /** The relayed step the app should perform now (a keeper may have done it already). */
  next: OpAction | null;
}

/**
 * Where an operation stands, from what is on chain. Pure. A redeem is sent when this holder's Claim on the
 * redeemed Source has been sent in full, and paid when `paidToHolder` (`YieldPaid`, or `InstantPaid` for an Instant
 * Redeem, to this holder's EVM address since the operation began) covers the operation's units: a Position-wide total
 * says nothing about this holder.
 */
export function opProgress(op: EthOp, s: EthState | null, vp: VaultPosition | null, paidToHolder: bigint | null = null): OpProgress {
  const bridge = s?.bridge ?? null;
  const core = s?.core ?? null;
  switch (op.kind) {
    case "open": {
      if (core && core.advances >= 1) return { stage: 5, next: null };
      if (core) return { stage: 3, next: "advance" };
      if (bridge && bridge.lastInSeq > 0n) return { stage: 2, next: "apply-locked" };
      return { stage: 1, next: null };
    }
    case "yield": {
      const base = BigInt(op.baseline ?? "0");
      if (!bridge || bridge.lastYieldSeq <= base) return { stage: 1, next: null };
      if (bridge.appliedYieldSeq >= bridge.lastYieldSeq) return { stage: 3, next: null };
      return { stage: 2, next: "apply-yield" };
    }
    case "redeem":
    case "instant": {
      const c = (op.kind === "instant" ? s?.instantClaim : s?.claim) ?? null;
      const target = op.sourceIndex !== undefined && op.baseline !== undefined ? BigInt(op.baseline) : (c?.unitsTotal ?? 0n);
      if (!c || target === 0n || c.unitsSent < target) return { stage: 1, next: op.kind === "instant" ? "send-pay-instant" : "send-pay-yield" };
      if (paidToHolder !== null && op.units !== undefined && paidToHolder >= BigInt(op.units)) return { stage: 3, next: null };
      return { stage: 2, next: null };
    }
    case "unlock": {
      if (vp?.unlocked) return { stage: 3, next: null };
      if (bridge?.unlockSent) return { stage: 2, next: null };
      return { stage: 1, next: "send-unlock" };
    }
  }
}

export interface ScanStatus {
  name: string;
  destinationTx: string | null;
}

/** LayerZero Scan status of a message by its source tx (EVM hash or Solana signature). Null while Scan has not indexed it. */
export async function fetchScanStatus(txHash: string): Promise<ScanStatus | null> {
  try {
    const res = await fetch(`${LZ_SCAN_API}/messages/tx/${txHash}`);
    if (!res.ok) return null;
    const m = ((await res.json()) as { data?: { status?: { name?: string }; destination?: { tx?: { txHash?: string } } }[] }).data?.[0];
    if (!m?.status?.name) return null;
    return { name: m.status.name, destinationTx: m.destination?.tx?.txHash ?? null };
  } catch {
    return null;
  }
}

/**
 * ETH Positions recorded on Solana with no Advance yet and no unfinished `open` operation in this browser
 * (opened elsewhere, storage cleared). Taking the Advance needs the owner's signature, so the Wallet starts
 * tracking these and the Advance continues there.
 */
export function untrackedOpens(positions: { eth: { vault: string; id: bigint } | null; status: string; advances: number }[], ops: EthOp[]) {
  return positions.flatMap((p) => {
    if (!p.eth || p.status !== "locked" || p.advances > 0) return [];
    const { vault, id } = p.eth;
    const tracked = ops.some((o) => o.kind === "open" && !o.done && o.vault.toLowerCase() === vault.toLowerCase() && o.id === id.toString());
    return tracked ? [] : [{ vault, id }];
  });
}

// ---- persistence (per Solana address, in this browser) ------------------------------------------------

const KEY = (address: string) => `tesoro-eth-ops:${address}`;
export const OPS_EVENT = "tesoro-eth-ops";

export function loadOps(address: string): EthOp[] {
  try {
    const raw = localStorage.getItem(KEY(address));
    return raw ? (JSON.parse(raw) as EthOp[]) : [];
  } catch {
    return [];
  }
}

function saveOps(address: string, ops: EthOp[]) {
  try {
    localStorage.setItem(KEY(address), JSON.stringify(ops));
  } catch {
    // private mode: the tracker works for this page load only
  }
  window.dispatchEvent(new Event(OPS_EVENT));
}

export function addOp(address: string, op: Omit<EthOp, "key" | "createdAt">): EthOp {
  const full: EthOp = { ...op, key: `${op.kind}-${op.vault}-${op.id}-${Date.now()}`, createdAt: Date.now() };
  saveOps(address, [full, ...loadOps(address)].slice(0, 20));
  return full;
}

export function patchOp(address: string, key: string, patch: Partial<EthOp>) {
  saveOps(address, loadOps(address).map((o) => (o.key === key ? { ...o, ...patch } : o)));
}

export function removeOp(address: string, key: string) {
  saveOps(address, loadOps(address).filter((o) => o.key !== key));
}
