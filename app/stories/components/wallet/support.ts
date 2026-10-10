import { PublicKey } from "@solana/web3.js";
import { ETH_VAULTS } from "@/lib/chain/eth";
import { demoSnapshot } from "@/lib/chain/fixture";
import type { NativeInfo, NativeMarket } from "@/lib/chain/native";
import type { AccountSnapshot, ChainPosition } from "@/lib/chain/read";
import { demoKey } from "../../screens/support/screen";

const key = (n: number) => new PublicKey(demoKey(n));

/** A SOL price of $110 and 7% a year: the figures the real market read returns on devnet. */
export const NATIVE_MARKET: NativeMarket = {
  pool: { baseRate: 1_000_000_000n, baseTs: Math.floor(Date.now() / 1000) - 86_400, apyBps: 700, speedup: 4380 },
  price: { microUsd: 110_000_000n, updatedTs: Math.floor(Date.now() / 1000) },
  simSol: 12_500_000_000n,
};

/** A SOL Position of 40 SOL with an Advance that is half repaid (or fully repaid, or unlocked). */
export function nativePosition(state: "debt" | "repaid" | "unlocked" = "debt"): ChainPosition {
  const issued = 10_500n;
  const returned = state === "debt" ? 5_000n : issued;
  const native: NativeInfo = {
    position: key(401),
    custody: key(402),
    status: state === "unlocked" ? "unlocked" : "locked",
    principalLamports: 40_000_000_000n,
    rateBps: 700,
    advances: 1,
    openAdvance: state === "unlocked" ? null : 0,
    cumulativeYield: 150_000_000n,
    freeYield: 0n,
    vaultShares: 40_000_000_000n,
    redeemedUnits: 0n,
    lastAccrualTs: Math.floor(Date.now() / 1000) - 30,
    source: {
      key: key(403),
      index: 0,
      horizonMonths: 3,
      math: { issued, returned, redeemed: 0n, yieldUnits: 1_000_000_000n, unitNum: 10_000_000_000_000n, unitDen: 110_000_000n },
    },
  };
  return {
    address: native.position,
    asset: "SOL",
    principal: 40,
    apy: 0.07,
    status: native.status,
    advances: 1,
    advance: { source: key(403), gemasIssued: Number(issued), horizonMonths: 3, debtGemas: Number(issued - returned) },
    debt: 0,
    yieldAccrued: 0.15,
    native,
    eth: null,
  };
}

/** The demo Account with a native SOL Position and the market read. */
export const nativeSnapshot = (state: "debt" | "repaid" | "unlocked" = "debt") => (a: string): AccountSnapshot => {
  const s = demoSnapshot(a);
  const p = nativePosition(state);
  return { ...s, positions: [p], market: NATIVE_MARKET, holdings: s.holdings.map((h, i) => (i === 0 ? { ...h, position: p.address, native: true, redeemable: 1240n } : h)) };
};

export function ethPosition(n: number, asset: "ETH" | "HYPE", paid = false): ChainPosition {
  const vault = ETH_VAULTS[asset === "ETH" ? 0 : 1].address;
  return {
    address: key(900 + n),
    asset,
    principal: asset === "ETH" ? 2 : 120,
    apy: asset === "ETH" ? 0.035 : 0.07,
    status: "locked",
    advances: 1,
    advance: { source: key(950 + n), gemasIssued: asset === "ETH" ? 6200 : 2400, horizonMonths: 3, debtGemas: asset === "ETH" ? 6200 : 2400 },
    debt: paid ? 0 : asset === "ETH" ? 0.021 : 3.4,
    yieldAccrued: asset === "ETH" ? 0.004 : 0.8,
    native: null,
    eth: { vault, id: BigInt(n) },
  };
}

export const ethSnapshot = (paid = false) => (a: string): AccountSnapshot => {
  const s = demoSnapshot(a);
  return { ...s, positions: [ethPosition(1, "ETH", paid), ethPosition(2, "HYPE", paid)] };
};

/** A saved ETH open in this browser, for the tracker and the Opening page. */
export function saveOpenOp(): void {
  try {
    const op = { key: "open-eth-9", kind: "open", vault: ETH_VAULTS[0].address, id: "9", createdAt: Date.now() - 90_000, months: 3, hash: `0x${"ab".repeat(32)}` };
    localStorage.setItem(`tesoro-eth-ops:${PublicKey.default.toBase58()}`, JSON.stringify([op]));
  } catch {}
}
