import { PublicKey } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { AdminOrder } from "@/server/admin/orders";
import { getChain } from "./client";
import { decodeOrder, fillInstantRedeemIxs } from "./instant-order";
import { sourceAccounts } from "./redeem";

/**
 * Fills (all or part of) one open Instant Redeem order from the admin wallet, which must be the fill authority.
 * Re-reads the order first, so a fill never uses a stale remaining figure, and creates any checkpoint page the landing needs.
 */
export async function fillOrder(signer: ChainSigner, order: Pick<AdminOrder, "address" | "position" | "source" | "stakeMint" | "kind">, gemas: bigint): Promise<string> {
  if (order.kind === "reported") throw new Error("ETH and HYPE orders are filled through the bridge, not here.");
  if (gemas <= 0n) throw new Error("Enter how many Gemas to fill.");
  const conn = getChain().base;
  const info = await conn.getAccountInfo(new PublicKey(order.address));
  if (!info) throw new Error("This order is gone: it was filled, cancelled or closed.");
  const decoded = decodeOrder(new PublicKey(order.address), info.data);
  if (gemas > decoded.line.amount) throw new Error(`Only ${decoded.line.amount} Gemas are still on offer.`);
  const { accounts, create } = await sourceAccounts(conn, decoded.source, [], signer.publicKey);
  const fill = fillInstantRedeemIxs({
    filler: signer.publicKey,
    order: decoded,
    position: new PublicKey(order.position),
    stakeMint: order.stakeMint ? new PublicKey(order.stakeMint) : null,
    gemas,
    book: accounts,
  });
  return getChain().sendBase(signer, [...create, ...fill]);
}
