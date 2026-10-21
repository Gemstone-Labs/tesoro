import type { ChainSigner } from "@/games/block-puzzle/chain";
import { fetchAccountState } from "@/lib/chain/read";
import { instantRedeemNative, redeemNative, unlockNative } from "@/lib/chain/native-flow";
import { runInstant } from "@/lib/chain/instant-run";
import { planCashOutNow, type VaultSnapshot } from "./vault";

/**
 * Where cashed-out winnings go. Today they land in the Player's wallet (test SOL on the test cluster). A bank or card
 * destination joins this union once an offramp provider is picked; callers already pass the option through.
 */
export type CashOutDestination = "wallet";

export interface CashOutOptions {
  cashOutTo?: CashOutDestination;
}

/** Refuses a destination this version can't pay yet, so a new one added to the union can't silently pay to the wallet. */
function wallet(options: CashOutOptions) {
  if (options.cashOutTo && options.cashOutTo !== "wallet") throw new Error("That way of cashing out isn't available yet.");
}

export interface CashOutResult {
  /** Gemas cashed out. */
  gemas: number;
  signatures: string[];
  /** The amounts moved while the Player was confirming, so part of it was left for them to look at again. */
  changed: boolean;
}

/** Withdraws a deposit that is ready: its SOL goes back to the wallet. */
export async function withdrawDeposit(signer: ChainSigner, snapshot: VaultSnapshot, id: string): Promise<string> {
  const info = snapshot.positions.find((p) => p.address.toBase58() === id)?.native;
  if (!info) throw new Error("That deposit isn't on your Account any more. Refresh and try again.");
  return unlockNative(signer, info);
}

/** Cashes out the won Gemas whose deposits have already earned, in full and free. */
export async function cashOutReady(signer: ChainSigner, snapshot: VaultSnapshot, options: CashOutOptions = {}): Promise<CashOutResult> {
  wallet(options);
  const rows = snapshot.holdings.filter((h) => !h.isOwn && h.native && h.redeemable > 0n);
  const signatures: string[] = [];
  for (const h of rows) signatures.push(await redeemNative(signer, h.position, h.source, h.redeemable, h.stakeMint));
  return { gemas: rows.reduce((t, h) => t + Number(h.redeemable), 0), signatures, changed: false };
}

/** Cashes out the won Gemas still waiting to earn, now, at Tesoro's price (the Treasury buys them). Re-reads before sending, never sends more than was shown. */
export async function cashOutNow(signer: ChainSigner, snapshot: VaultSnapshot, options: CashOutOptions = {}): Promise<CashOutResult> {
  wallet(options);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const plan = planCashOutNow(snapshot.holdings, snapshot.market, nowSec());
  let latest = plan;
  const signatures: string[] = [];
  const run = await runInstant(
    plan.map((p) => p.line),
    async () => {
      const fresh = await fetchAccountState(signer.publicKey, { fresh: true });
      latest = planCashOutNow(fresh.holdings, fresh.market, nowSec());
      return latest.map((p) => p.line);
    },
    async (line) => {
      const h = (latest.find((p) => p.line.key === line.key) ?? plan.find((p) => p.line.key === line.key))!.holding;
      signatures.push(await instantRedeemNative(signer, h.position, h.source, line.gemas, h.redeemable, h.stakeMint));
    },
  );
  return { gemas: run.sent.reduce((t, l) => t + Number(l.gemas), 0), signatures, changed: run.kind !== "sent" };
}
