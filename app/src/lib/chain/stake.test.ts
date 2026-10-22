import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import {
  TESORO_CORE_ID,
  TOKEN_PROGRAM_ID,
  accountPda,
  nativeInfoFrom,
  nativeNow,
  pythFeedAddress,
  sourcePda,
  stakeGrowthOf,
  unlockEstimateMs,
  type NativeInfo,
} from "./native";
import {
  JITOSOL,
  STAKE_CONFIG_LEN,
  STAKE_CUSTODY_LEN,
  extendStakeAdvanceIx,
  initTreasuryStakeIx,
  parseStakeConfig,
  openStakePositionIx,
  parseStakeCustody,
  redeemStakeIx,
  redeemTreasuryStakeIx,
  setStakeApyCeilingIx,
  setStakeTokenIx,
  stakeConfigPda,
  stakeCustodyPda,
  stakeMarketFrom,
  stakeMarketKeys,
  stakePositionPda,
  stakeVaultPda,
  takeStakeAdvanceIx,
  tokensForUnits,
  unitsForTokens,
  unlockStakeIx,
  withdrawTreasuryStakeIx,
} from "./stake";
import { STAKE_RATE_SCALE, tokenAta } from "./stake-pool";
import { accruedYieldAt, positionAccrued, stakeGrowthAt, type StakeGrowth } from "./yield";

const SOL = 1_000_000_000n;
const owner = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const target = { line: { side: 1, dueAt: 5n, class: 3, tranche: 0 }, accounts: [] as PublicKey[] };
const R0 = 1_300_000_000_000n;

type Spec = { name: string; accounts: { writable?: boolean; signer?: boolean; optional?: boolean }[] };
const spec = (name: string) => (idl.instructions as Spec[]).find((i) => i.name === name)!;

describe("instruction encoders match the IDL", () => {
  const cases: [string, ReturnType<typeof openStakePositionIx>][] = [
    ["open_stake_position", openStakePositionIx(owner, 1, SOL, position)],
    ["take_stake_advance", takeStakeAdvanceIx(owner, position, 1, 3, 560n)],
    ["extend_stake_advance", extendStakeAdvanceIx(owner, position, 0, 2, 3n, [])],
    ["withdraw_treasury_stake", withdrawTreasuryStakeIx(owner, owner, 5n)],
    ["set_stake_token", setStakeTokenIx(owner)],
    ["set_stake_apy_ceiling", setStakeApyCeilingIx(owner, 800)],
    ["init_treasury_stake", initTreasuryStakeIx(owner, 2000, 2500)],
  ];
  it.each(cases)("%s: account count, writable and signer flags, discriminator", (name, ix) => {
    const s = spec(name);
    expect(s, name).toBeDefined();
    expect(ix.keys).toHaveLength(s.accounts.length);
    s.accounts.forEach((a, i) => {
      expect(ix.keys[i].isWritable, `${name} #${i}`).toBe(!!a.writable);
      expect(ix.keys[i].isSigner, `${name} #${i} signer`).toBe(!!a.signer);
    });
    const disc = (idl.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === name)!.discriminator;
    expect([...ix.data.subarray(0, 8)]).toEqual(disc);
  });

  it("appends the stake tail to redeem, unlock, return_own and redeem_treasury", () => {
    const rdm = redeemStakeIx(owner, position, position, 5n, target);
    expect(rdm.keys).toHaveLength(spec("redeem").accounts.length + 5);
    expect(rdm.keys.slice(6).map((k) => k.pubkey.toBase58())).toEqual(
      [stakeCustodyPda(JITOSOL.mint), JITOSOL.pool, stakeVaultPda(JITOSOL.mint), tokenAta(owner, JITOSOL.mint), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    const unl = unlockStakeIx(owner, position, { index: 2, accounts: [] });
    expect(unl.keys).toHaveLength(spec("unlock").accounts.length + 5 + 1);
    expect(unl.keys[unl.keys.length - 1].pubkey.equals(sourcePda(position, 2))).toBe(true);
    expect(unlockStakeIx(owner, position).keys).toHaveLength(spec("unlock").accounts.length + 5);
    expect(redeemTreasuryStakeIx(position, position, 5n, target).keys).toHaveLength(spec("redeem_treasury").accounts.length + 2);
  });

  it("carries the Gemas floor as the last argument of take_stake_advance and extend_stake_advance", () => {
    expect(takeStakeAdvanceIx(owner, position, 0, 1, 560n).data.subarray(8).toString("hex")).toBe("01" + "3002000000000000");
    expect(extendStakeAdvanceIx(owner, position, 0, 2, 3n, []).data.subarray(8).toString("hex")).toBe("02" + "0300000000000000");
  });

  it("prices only from the token's Pyth mapping and the SOL/USD sponsored feed", () => {
    const ix = takeStakeAdvanceIx(owner, position, 0, 1, 560n);
    expect(ix.keys[4].pubkey.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from("onchain_price"), JITOSOL.mint.toBuffer()], TESORO_CORE_ID)[0].toBase58());
    expect(ix.keys[5].pubkey.equals(pythFeedAddress("SOL"))).toBe(true);
    expect(ix.keys[2].pubkey.equals(accountPda(owner))).toBe(false);
    expect(ix.keys[9].pubkey.equals(sourcePda(position, 0))).toBe(true);
    expect(ix.keys).toHaveLength(spec("take_stake_advance").accounts.length);
    const prev = takeStakeAdvanceIx(owner, position, 1, 3, 560n, { index: 0, accounts: [] });
    expect(prev.keys[spec("take_stake_advance").accounts.length].pubkey.equals(sourcePda(position, 0))).toBe(true);
  });

  it("derives the Position id the way the program does: sha256('stake' || owner || nonce)", async () => {
    const pda = await stakePositionPda(owner, 7);
    expect(pda.toBase58()).not.toBe("");
    const again = await stakePositionPda(owner, 7);
    expect(again.equals(pda)).toBe(true);
    expect((await stakePositionPda(owner, 8)).equals(pda)).toBe(false);
  });
});

describe("growth since open is the Staking Rate ratio (same numbers as ledger/stake.rs)", () => {
  const clock = { principal: 13n * SOL, rateBps: 649, openedAt: 1_000_000, stakeRateOpen: R0 };

  it("1% growth on 13 SOL: 0.13 SOL, all of it (the Yield Fee waits for the cash-out)", () => {
    const now = 1_000_100;
    const stake: StakeGrowth = { rateNow: 1_313_000_000_000n, atSec: now, apyBps: 649 };
    const a = positionAccrued(clock, 1, now, stake);
    expect(a).toBe(130_000_000n);
    expect(accruedYieldAt(13n * SOL, { num: stake.rateNow, den: R0 })).toBe(a);
  });

  it("shows no growth without a rate and none when the pool lost value", () => {
    expect(positionAccrued(clock, 1, 2_000_000)).toBe(0n);
    expect(positionAccrued(clock, 1, 1_000_100, { rateNow: R0 - 1n, atSec: 1_000_100, apyBps: 649 })).toBe(0n);
  });

  it("projects ahead of the read at the sizing APY, and is exact at the read", () => {
    const stake: StakeGrowth = { rateNow: R0, atSec: 1_000_000, apyBps: 1000 };
    expect(stakeGrowthAt(R0, stake, 1_000_000).num).toBe(R0);
    // A year ahead at 10%: the rate is 10% up.
    expect(stakeGrowthAt(R0, stake, 1_000_000 + 31_536_000).num).toBe(R0 + R0 / 10n);
  });

  it("the Unlock Estimate of a Debt is when projected yield covers it", () => {
    const stake: StakeGrowth = { rateNow: R0, atSec: 1_000_000, apyBps: 649 };
    const source = { issued: 2_500n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 150_000_000n };
    const at = unlockEstimateMs({ clock, speedup: 1, appliedNet: 0n, source, nowMs: 1_000_000_000, stake });
    expect(at).not.toBeNull();
    // 2,500 Gemas = $25 = 0.1667 SOL owed; 13 SOL at 6.49% earns 0.844 SOL a year: about 0.2 years.
    const years = (at! - 1_000_000_000) / 1000 / 31_536_000;
    expect(years).toBeGreaterThan(0.17);
    expect(years).toBeLessThan(0.23);
    // No projection without a growth source.
    expect(unlockEstimateMs({ clock, speedup: 1, appliedNet: 0n, source, nowMs: 1_000_000_000 })).toBeNull();
  });
});

/** A PositionState image as the program serialises it (enough fields for nativeInfoFrom). */
function positionData(over: { mint: PublicKey; stakeRateOpen: bigint; shares: bigint; principal: bigint }) {
  const b = Buffer.alloc(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 8);
  let o = 8 + 1 + 32 + 32 + 1;
  over.mint.toBuffer().copy(b, o);
  o += 32;
  b[o++] = 9;
  b.writeBigUInt64LE(over.principal, o);
  o += 8;
  b.writeUInt16LE(649, o);
  o += 2;
  b[o++] = 0; // Locked
  b.writeUInt32LE(1, o); // advances
  o += 4;
  b[o++] = 0; // open_advance None
  o += 8 + 8; // last_seq, cumulative_yield
  o += 16; // free_yield, free_yield_claimed
  b.writeBigInt64LE(1_000_000n, o); // opened_at
  o += 8;
  o += 8; // applied_net
  b.writeBigUInt64LE(over.shares, o); // custody_shares
  o += 8;
  b.writeUInt16LE(2000, o); // yield_fee_bps
  o += 2;
  b.writeBigUInt64LE(over.stakeRateOpen, o);
  return b;
}

describe("a stake Position as the app reads it", () => {
  const data = positionData({ mint: JITOSOL.mint, stakeRateOpen: R0, shares: 10n * SOL, principal: 13n * SOL });
  const pos = { data, owner: TESORO_CORE_ID, executable: false, lamports: 1 } as AccountInfo<Buffer>;

  it("carries its token, the rate it opened at and its shares", () => {
    const info = nativeInfoFrom(position, pos, null);
    expect(info.mint.equals(JITOSOL.mint)).toBe(true);
    expect(info.stakeRateOpen).toBe(R0);
    expect(info.custodyShares).toBe(10n * SOL);
    expect(info.principalLamports).toBe(13n * SOL);
    expect(info.yieldFeeBps).toBe(2000);
    expect(info.openedAt).toBe(1_000_000);
  });

  it("derives its Accrued Yield from the pool's rate through nativeNow, with no speedup", () => {
    const info: NativeInfo = nativeInfoFrom(position, pos, null);
    const stake = stakeGrowthOf({ stake: { rate: 1_313_000_000_000n, sizingBps: 649 } as never }, 1_000_050);
    expect(nativeNow(info, 1, 1_000_050, stake).accrued).toBe(130_000_000n);
    // A simulated Position (no rate at open) is unchanged by a stake growth source.
    const sim = nativeInfoFrom(position, { ...pos, data: positionData({ mint: JITOSOL.mint, stakeRateOpen: 0n, shares: 10n * SOL, principal: 13n * SOL }) } as AccountInfo<Buffer>, null);
    expect(nativeNow(sim, 4380, 1_000_600, stake).accrued).toBe(nativeNow(sim, 4380, 1_000_600).accrued);
  });
});

describe("the Treasury mirror equals the program's", () => {
  it("converts at the rate of the moment and rounds down", () => {
    expect(tokensForUnits(1_300_000_000n, R0)).toBe(SOL);
    expect(tokensForUnits(1n, R0)).toBe(0n);
    expect(unitsForTokens(SOL, R0)).toBe(1_300_000_000n);
    expect(STAKE_RATE_SCALE).toBe(10n ** 12n);
  });
});

describe("the mainnet market", () => {
  const dir = join(__dirname, "../../../../programs/tesoro_core/tests/fixtures");
  const poolBytes = readFileSync(join(dir, "jito_pool.bin"));
  const acct = (data: Buffer, ownerKey: PublicKey): AccountInfo<Buffer> => ({ data, owner: ownerKey, executable: false, lamports: 1 });
  const config = (active: PublicKey, ceiling: number) => {
    const b = Buffer.alloc(STAKE_CONFIG_LEN);
    active.toBuffer().copy(b, 9);
    b.writeUInt16LE(ceiling, 41);
    return b;
  };
  const custodyBytes = () => {
    const b = Buffer.alloc(STAKE_CUSTODY_LEN);
    JITOSOL.mint.toBuffer().copy(b, 10);
    JITOSOL.pool.toBuffer().copy(b, 42);
    stakeVaultPda(JITOSOL.mint).toBuffer().copy(b, 74);
    return b;
  };
  const tokenAcct = (amount: bigint) => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amount, 64);
    return b;
  };
  const infos = (activeMint: PublicKey, ceiling: number): (AccountInfo<Buffer> | null)[] => [
    acct(config(activeMint, ceiling), TESORO_CORE_ID),
    acct(poolBytes, JITOSOL.poolProgram),
    acct(custodyBytes(), TESORO_CORE_ID),
    acct(tokenAcct(0n), TOKEN_PROGRAM_ID),
    acct(tokenAcct(7n * SOL), TOKEN_PROGRAM_ID),
    null,
    null,
  ];

  it("decodes the setting and the custody the program writes", () => {
    const cfg = parseStakeConfig(config(JITOSOL.mint, 800));
    expect(cfg!.activeMint.equals(JITOSOL.mint)).toBe(true);
    expect(cfg!.apyCeilingBps).toBe(800);
    expect(parseStakeConfig(Buffer.alloc(10))).toBeNull();
    const c = parseStakeCustody(custodyBytes())!;
    expect(c.mint.equals(JITOSOL.mint) && c.pool.equals(JITOSOL.pool)).toBe(true);
    // principal u128 at 106, open_positions, refilled, instant, withdrawn u64, then the route (ticket 31 layout).
    const b = custodyBytes();
    b.writeBigUInt64LE(13n * SOL, 106);
    b.writeBigUInt64LE(2n, 122);
    b.writeBigUInt64LE(9n, 146);
    b.writeBigUInt64LE(77n, 154);
    const f = parseStakeCustody(b)!;
    expect([f.principal, f.openPositions, f.withdrawnShares, f.route.treasuryShares]).toEqual([13n * SOL, 2n, 9n, 77n]);
    expect(parseStakeCustody(Buffer.alloc(10))).toBeNull();
  });

  it("reads the keys in the order it decodes them", () => {
    const keys = stakeMarketKeys(owner);
    expect(keys[0].equals(stakeConfigPda())).toBe(true);
    expect(keys[1].equals(JITOSOL.pool)).toBe(true);
    expect(keys[2].equals(stakeCustodyPda(JITOSOL.mint))).toBe(true);
    expect(keys[4].equals(tokenAta(owner, JITOSOL.mint))).toBe(true);
  });

  it("opens only while the setting names the token, the ceiling is set and the custody exists", () => {
    const m = stakeMarketFrom(infos(JITOSOL.mint, 800));
    expect(m.stake!.open).toBe(true);
    expect(m.stake!.tokenBalance).toBe(7n * SOL);
    expect(m.simSol).toBe(7n * SOL);
    expect(m.stake!.sizingBps).toBeGreaterThan(0);
    expect(m.stake!.sizingBps).toBeLessThanOrEqual(800);
    expect(m.pool.apyBps).toBe(m.stake!.sizingBps);
    expect(stakeMarketFrom(infos(JITOSOL.mint, 0)).stake!.open).toBe(false);
    expect(stakeMarketFrom(infos(Keypair.generate().publicKey, 800)).stake!.open).toBe(false);
    const noCustody = infos(JITOSOL.mint, 800);
    noCustody[2] = null;
    expect(stakeMarketFrom(noCustody).stake!.open).toBe(false);
  });

  it("refuses a pool account owned by another program", () => {
    const bad = infos(JITOSOL.mint, 800);
    bad[1] = acct(poolBytes, Keypair.generate().publicKey);
    expect(() => stakeMarketFrom(bad)).toThrow(/not readable/);
  });
});
