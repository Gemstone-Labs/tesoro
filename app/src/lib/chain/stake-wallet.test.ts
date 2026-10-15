import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  POOL,
  SIM_SOL_MINT,
  TESORO_CORE_ID,
  TOKEN_PROGRAM_ID,
  accruedAt,
  ataOf,
  custodyPda,
  extendNativeAdvanceIx,
  instantRedeemIx,
  nativeInfoFrom,
  redeemIx,
  redeemTreasuryIx,
  simSolAta,
  sourcePda,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  treasuryPda,
  treasuryVaultPda,
  unlockEstimateMs,
  unlockIx,
  vaultPda,
  yieldClockOf,
  accrueNativeYieldIx,
  pda,
  s,
  type TokenCustody,
} from "./native";
import { TREASURY_LEN } from "./fees";
import { solSourceOf, stakeMarketFrom, stakeMarketKeys, stakeMarketKeys2, tokenOfCustody, treasuryVaultOf, accrueYieldIx } from "./stake-market";
import { parseStakePool, solSourcePda, tokenApyPda, tokenAta, tokenTreasuryVaultPda } from "./stake-pool";

const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const JITO_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const SOL = 1_000_000_000n;
const source = { mint: JITO_MINT, pool: JITO_POOL };
const livePool = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
const poolView = parseStakePool(livePool)!;

const info = (data: Buffer, owner = TESORO_CORE_ID): AccountInfo<Buffer> => ({ data, owner, lamports: 1, executable: false });
const tokenAccount = (amount: bigint, mint = JITO_MINT) => {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  d.writeBigUInt64LE(amount, 64);
  return info(d, TOKEN_PROGRAM_ID);
};

describe("the Treasury's vault of the staking token", () => {
  const original = Keypair.generate().publicKey;
  const treasuryData = (vault: PublicKey, yieldBps = 2000, instantBps = 2500) => {
    const d = Buffer.alloc(TREASURY_LEN);
    d.writeUInt16LE(yieldBps, 11);
    d.writeUInt16LE(instantBps, 13);
    vault.toBuffer().copy(d, 47);
    return info(d);
  };

  it("is the original vault when that holds the token, otherwise the one at [treasury_vault, mint]", () => {
    expect(treasuryVaultOf(JITO_MINT, treasuryData(original), tokenAccount(5n)).equals(original)).toBe(true);
    expect(treasuryVaultOf(JITO_MINT, treasuryData(original), tokenAccount(5n, SIM_SOL_MINT)).equals(tokenTreasuryVaultPda(JITO_MINT))).toBe(true);
    expect(treasuryVaultOf(JITO_MINT, null, null).equals(tokenTreasuryVaultPda(JITO_MINT))).toBe(true);
  });

  it("is what round two of the market read asks for", () => {
    const wallet = Keypair.generate().publicKey;
    const keys = stakeMarketKeys2(wallet, source, treasuryData(original));
    expect(keys.map((k) => k.toBase58())).toEqual(
      [JITO_POOL, tokenApyPda(JITO_MINT), pda([s("price"), JITO_MINT.toBuffer()]), tokenAta(wallet, JITO_MINT), tokenTreasuryVaultPda(JITO_MINT), original].map((k) => k.toBase58()),
    );
    expect(stakeMarketKeys().map((k) => k.toBase58())).toEqual([solSourcePda().toBase58(), treasuryPda().toBase58()]);
  });

  it("builds the market from the pool's rate, the published APY, the price and the wallet's tokens", () => {
    const apy = Buffer.alloc(8 + 1 + 32 + 2 + 8 + 2);
    apy.writeUInt16LE(612, 41);
    apy.writeBigInt64LE(1_800_000_000n, 43);
    apy.writeUInt16LE(900, 51);
    const feed = Buffer.alloc(57);
    feed.writeBigUInt64LE(240_000_000n, 41);
    feed.writeBigInt64LE(1_800_000_000n, 49);
    const m = stakeMarketFrom(source, treasuryData(original), [info(livePool, new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy")), info(apy), info(feed), tokenAccount(3n * SOL), null, tokenAccount(7n * SOL)], 1_800_000_100);
    expect(m.pool).toEqual({ baseRate: (poolView.totalLamports * SOL) / poolView.poolTokenSupply, baseTs: 1_800_000_100, apyBps: 612, speedup: 1 });
    // The ceiling caps it; a published APY older than 3 days, or no ceiling, sizes nothing.
    const keys = [info(livePool, new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy")), null, info(feed), tokenAccount(3n * SOL), null, tokenAccount(7n * SOL)];
    const at = (apyData: Buffer, now: number) => stakeMarketFrom(source, treasuryData(original), [keys[0], info(apyData), ...keys.slice(2)], now).pool.apyBps;
    const capped = Buffer.from(apy);
    capped.writeUInt16LE(500, 51);
    expect(at(capped, 1_800_000_100)).toBe(500);
    expect(at(apy, 1_800_000_000 + 3 * 86_400 + 1)).toBe(0);
    capped.writeUInt16LE(0, 51);
    expect(at(capped, 1_800_000_100)).toBe(0);
    expect(m.simSol).toBe(3n * SOL);
    expect(m.price).toEqual({ microUsd: 240_000_000n, updatedTs: 1_800_000_000 });
    expect(m.treasury).toEqual({ yieldFeeBps: 2000, instantFeeBps: 2500 });
    expect(m.treasuryShares).toBe(7n * SOL);
    expect(m.token?.treasuryVault.equals(original)).toBe(true);
    expect(m.token?.symbol).toBe("jitoSOL");
  });

  it("says the pool is unreadable rather than guessing a rate, and reads the setting only from the program's own account", () => {
    expect(() => stakeMarketFrom(source, null, [null, null, null, null, null])).toThrow(/not readable/);
    const setting = Buffer.concat([Buffer.alloc(9), JITO_MINT.toBuffer(), JITO_POOL.toBuffer()]);
    expect(solSourceOf(info(setting))).toEqual(source);
    expect(solSourceOf(info(setting, Keypair.generate().publicKey))).toBeNull();
    expect(solSourceOf(null)).toBeNull();
  });
});

/** A Position and its custody as the program lays them out. */
function fixture(stakePool: boolean, overrides: { tracked?: bigint; vaultBalance?: bigint } = {}) {
  const position = Keypair.generate().publicKey;
  const pos = Buffer.alloc(220);
  pos.writeBigUInt64LE(100n * SOL, 107); // principal
  pos.writeUInt16LE(612, 115); // rate_bps
  pos[117] = 0; // locked
  pos.writeUInt32LE(1, 118); // advances
  pos[122] = 1; // open advance
  pos.writeUInt32LE(0, 123);
  const cust = Buffer.alloc(stakePool ? 219 : 210);
  const tok = stakePool ? { pool: JITO_POOL, mint: JITO_MINT } : { pool: POOL, mint: SIM_SOL_MINT };
  tok.pool.toBuffer().copy(cust, 74);
  tok.mint.toBuffer().copy(cust, 106);
  const tracked = overrides.tracked ?? 100n * SOL;
  cust.writeBigUInt64LE(tracked, 194);
  cust.writeBigInt64LE(1_800_000_000n, 202);
  if (stakePool) cust[210] = 2;
  const vault = tokenAccount(overrides.vaultBalance ?? tracked);
  return { position, nativeInfo: nativeInfoFrom(position, info(pos), info(cust), vault, null), tok };
}

describe("reading a stake pool custody", () => {
  it("names the token and the pool that values it, and flags the stake pool marker", () => {
    const { nativeInfo } = fixture(true);
    expect(nativeInfo.stakePool).toBe(true);
    expect(nativeInfo.mint.equals(JITO_MINT)).toBe(true);
    expect(nativeInfo.pool.equals(JITO_POOL)).toBe(true);
    expect(nativeInfo.vaultShares).toBe(100n * SOL);
    const sim = fixture(false).nativeInfo;
    expect(sim.stakePool).toBe(false);
    expect(sim.pool.equals(POOL)).toBe(true);
    expect(sim.mint.equals(SIM_SOL_MINT)).toBe(true);
  });

  it("reads the token and pool from the custody bytes, and nothing for a simSOL custody", () => {
    const cust = Buffer.alloc(219);
    JITO_POOL.toBuffer().copy(cust, 74);
    JITO_MINT.toBuffer().copy(cust, 106);
    expect(tokenOfCustody(cust)).toBeNull();
    cust[210] = 2;
    const t = tokenOfCustody(cust)!;
    expect(t.mint.equals(JITO_MINT) && t.pool.equals(JITO_POOL)).toBe(true);
    expect(tokenOfCustody(Buffer.alloc(210))).toBeNull();
  });

  it("projects nothing on top of the pool rate (the yield is already in it) but times the Unlock Estimate by the recorded APY", () => {
    const { nativeInfo } = fixture(true);
    const clock = yieldClockOf(nativeInfo)!;
    expect(clock).toMatchObject({ rateBps: 612, realized: true });
    // The pool's rate has grown 1% since open: 1 SOL of yield on 100 SOL, no projected increment on top at any later time.
    const pool = { baseRate: 1_010_000_000n, baseTs: 1_800_000_000, apyBps: 612, speedup: 1 };
    const args = { vaultShares: 100n * SOL, redeemedUnits: 0n, principalLamports: 100n * SOL, pool: { ...pool }, nowMs: 0 };
    const now = accruedAt({ ...args, clock, nowMs: 1_800_000_000_000 });
    const later = accruedAt({ ...args, clock, nowMs: 1_800_000_000_000 + 10 * 86_400_000 });
    expect(now).toBe(1n * SOL);
    expect(later).toBe(now);
    const sim = yieldClockOf(fixture(false).nativeInfo)!;
    expect(accruedAt({ ...args, pool: { ...pool, apyBps: 700, speedup: 4380 }, clock: sim, nowMs: 1_800_000_000_000 + 600_000 })).toBeGreaterThan(now);
  });

  it("estimates the Unlock from the Position's recorded rate in real time", () => {
    const { nativeInfo } = fixture(true);
    const clock = yieldClockOf(nativeInfo)!;
    const sourceMath = { issued: 1_000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 10n ** 8n };
    const nowMs = 1_800_000_000_000;
    const args = { source: sourceMath, vaultShares: 100n * SOL, redeemedUnits: 0n, principalLamports: 100n * SOL, pool: { baseRate: SOL, baseTs: 0, apyBps: 612, speedup: 1 }, nowMs };
    const slow = unlockEstimateMs({ ...args, clock })!;
    const fast = unlockEstimateMs({ ...args, clock: { ...clock, rateBps: clock.rateBps * 2 } })!;
    expect(slow).toBeGreaterThan(nowMs);
    expect(fast - nowMs).toBeLessThan(slow - nowMs);
    // 1,000 Gemas = 1e8 lamports of yield; 100 SOL at 6.12% keeps 80% after the 20% fee, about 155 lamports a second: about 179 hours.
    expect((slow - nowMs) / 3_600_000).toBeCloseTo(179, 0);
  });
});

describe("payout accounts of a stake pool custody", () => {
  const holder = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const treasuryVault = tokenTreasuryVaultPda(JITO_MINT);
  const tok: TokenCustody = { mint: JITO_MINT, pool: JITO_POOL, treasuryVault };
  const holderAta = ataOf(holder, JITO_MINT);
  const names = (ix: { keys: { pubkey: PublicKey; isWritable: boolean }[] }, from: number) => ix.keys.slice(from).map((k) => [k.pubkey.toBase58(), k.isWritable]);

  it("Redeem keeps the five remaining accounts: custody, vault, the holder's token account, the stake pool, the token program", () => {
    const ix = redeemIx(holder, position, sourcePda(position, 0), 10n, tok);
    expect(names(ix, 5)).toEqual([
      [custodyPda(position).toBase58(), true],
      [vaultPda(position).toBase58(), true],
      [holderAta.toBase58(), true],
      [JITO_POOL.toBase58(), false],
      [TOKEN_PROGRAM_ID.toBase58(), false],
    ]);
  });

  it("Unlock and sweep add [treasury, treasury vault] so the Yield Fee on the rate's growth is settled first", () => {
    const unlock = unlockIx(holder, position, tok);
    expect(unlock.keys.length).toBe(3 + 5 + 2);
    expect(names(unlock, 5)).toEqual([
      [holderAta.toBase58(), true],
      [JITO_POOL.toBase58(), false],
      [TOKEN_PROGRAM_ID.toBase58(), false],
      [treasuryPda().toBase58(), true],
      [treasuryVault.toBase58(), true],
    ]);
    const sweep = sweepNativeSurplusIx(holder, position, tok);
    expect(sweep.keys.length).toBe(8 + 2);
    expect(sweep.keys[5].pubkey.equals(holderAta)).toBe(true);
    expect(sweep.keys[6].pubkey.equals(JITO_POOL)).toBe(true);
    expect(sweep.keys.slice(8).map((k) => [k.pubkey.toBase58(), k.isWritable])).toEqual([
      [treasuryPda().toBase58(), true],
      [treasuryVault.toBase58(), true],
    ]);
  });

  it("Instant Redeem pays from the Treasury's vault of the token into the holder's token account, valued by the stake pool", () => {
    const ix = instantRedeemIx(holder, position, sourcePda(position, 0), 10n, tok);
    expect(ix.keys.length).toBe(13);
    expect(ix.keys[8].pubkey.equals(treasuryVault)).toBe(true);
    expect(ix.keys[9].pubkey.equals(holderAta)).toBe(true);
    expect(ix.keys[10].pubkey.equals(JITO_POOL)).toBe(true);
    expect(ix.keys[11].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("the Treasury's own redeem lands in its vault of the token", () => {
    const ix = redeemTreasuryIx(position, sourcePda(position, 0), 10n, tok);
    expect(ix.keys[7].pubkey.equals(treasuryVault)).toBe(true);
    expect(ix.keys[8].pubkey.equals(JITO_POOL)).toBe(true);
  });

  it("the crank is the stake pool one for a stake pool custody and the simSOL one otherwise", () => {
    const real = fixture(true).nativeInfo;
    const a = accrueYieldIx(real, tok);
    expect(a.keys.map((k) => k.pubkey.toBase58())).toContain(JITO_POOL.toBase58());
    expect(a.keys.length).toBe(8);
    expect(a.data.equals(accrueNativeYieldIx(real.position, real.openAdvance).data)).toBe(false);
    const sim = fixture(false).nativeInfo;
    expect(accrueYieldIx(sim).data.equals(accrueNativeYieldIx(sim.position, sim.openAdvance).data)).toBe(true);
  });

  it("another Advance is priced by the token's own feed", () => {
    const ix = takeNativeAdvanceIx(holder, position, 1, 3, JITO_MINT);
    expect(ix.keys[4].pubkey.equals(pda([s("price"), JITO_MINT.toBuffer()]))).toBe(true);
    expect(extendNativeAdvanceIx(holder, position, 0, 2).keys.length).toBe(9);
  });

  it("test mode keeps the simSOL accounts and no Treasury extras", () => {
    const unlock = unlockIx(holder, position);
    expect(unlock.keys.length).toBe(8);
    expect(unlock.keys[5].pubkey.equals(simSolAta(holder))).toBe(true);
    expect(unlock.keys[6].pubkey.equals(POOL)).toBe(true);
    expect(sweepNativeSurplusIx(holder, position).keys.length).toBe(8);
    expect(instantRedeemIx(holder, position, sourcePda(position, 0), 10n).keys[8].pubkey.equals(treasuryVaultPda())).toBe(true);
    expect(redeemIx(holder, position, sourcePda(position, 0), 10n).keys[7].pubkey.equals(simSolAta(holder))).toBe(true);
  });
});

describe("the Account read on the mainnet cluster", () => {
  it("reads the setting, then the token's pool, APY, price and the wallet's token account, as the market", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_TESORO_CLUSTER", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_ETHEREUM_RPC", "http://eth.invalid");
    vi.stubEnv("NEXT_PUBLIC_HYPEREVM_RPC", "http://hl.invalid");
    try {
      const { readAccountState } = await import("./account-state");
      const wallet = Keypair.generate().publicKey;
      const accountKey = Keypair.generate().publicKey;
      const setting = info(Buffer.concat([Buffer.alloc(9), JITO_MINT.toBuffer(), JITO_POOL.toBuffer()]));
      const byKey = new Map<string, AccountInfo<Buffer>>([
        [solSourcePda().toBase58(), setting],
        [JITO_POOL.toBase58(), info(livePool, new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"))],
        [tokenAta(wallet, JITO_MINT).toBase58(), tokenAccount(2n * SOL)],
      ]);
      const rounds: number[] = [];
      const snap = await readAccountState(
        {
          lists: async () => [[], []],
          infos: async (keys) => {
            rounds.push(keys.length);
            return keys.map((k) => byKey.get(k.toBase58()) ?? null);
          },
          balance: async () => 5,
          decode: () => {
            throw new Error("none");
          },
        },
        wallet,
        accountKey,
      );
      expect(rounds).toEqual([3, 5]);
      expect(snap.market?.simSol).toBe(2n * SOL);
      expect(snap.market?.token?.symbol).toBe("jitoSOL");
      expect(snap.market?.pool.speedup).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
