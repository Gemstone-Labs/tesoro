import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { backingPairIx, chunkIx, coreIx, growIx, joinMatchIx, key, openMatchIx, playerIx } from "./fixtures";
import { CORE_ID, ORDER_RENT, ROWS, TX_SHAPES, planTransaction, type Ix } from "./rules";

const relayer = key();
const player = key();
const game = key();
const ctx = { relayer, player, isGame: (p: { equals(o: unknown): boolean }) => p.equals(game) };
const plan = (ixs: Ix[]) => planTransaction(ixs, ctx);
const refused = (ixs: Ix[], code: string) => expect(() => plan(ixs)).toThrowError(expect.objectContaining({ code }));

describe("the table matches the program", () => {
  const ixs = (coreIdl as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions;
  it("every row names a real instruction and real relayer slots", () => {
    for (const [name, row] of Object.entries(ROWS)) {
      const ix = ixs.find((i) => i.name === name);
      expect(ix, name).toBeTruthy();
      for (const slot of row.relayer) expect(ix!.accounts.map((a) => a.name), `${name}.${slot}`).toContain(slot);
    }
  });
  it("every shape is built from rows", () => {
    for (const shape of TX_SHAPES) for (const n of shape) expect(ROWS[n], n).toBeTruthy();
  });
  it("sponsoring never covers admin or treasury instructions", () => {
    for (const n of ["set_sponsor", "init_sponsor", "withdraw_treasury", "set_admin", "register_game", "list_game", "update_config", "settle_match"]) expect(ROWS[n], n).toBeUndefined();
  });
});

describe("accepted", () => {
  it("an open_match with the relayer as payer is an admission that fronts a deposit", async () => {
    const p = plan([await openMatchIx(relayer, player, game)]);
    expect(p).toMatchObject({ kind: "core", names: ["open_match"], class: "admission" });
    expect(p.spend.refundable).toBeGreaterThan(0n);
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
  });
  it("a chunk is an exit with the relayer as caller, and may carry many Source accounts", async () => {
    const p = plan([await chunkIx(relayer, key(), 60)]);
    expect(p).toMatchObject({ names: ["match_chunk"], class: "exit" });
    expect(p.signers).toEqual([]);
  });
  it("a Game instruction without the relayer, signed by the Player, for a listed Game", () => {
    const p = plan([{ programId: game, keys: [{ pubkey: player, isSigner: true, isWritable: true }, { pubkey: key(), isSigner: false, isWritable: true }], data: new Uint8Array([1, 2, 3]) }]);
    expect(p).toMatchObject({ kind: "game", class: "continue" });
  });
});

describe("refused", () => {
  it("the relayer anywhere but its slot, writable or not", async () => {
    const ix = await chunkIx(relayer, key());
    const potA = ix.keys.findIndex((k) => k.isWritable && !k.isSigner);
    ix.keys[potA] = { pubkey: relayer, isSigner: false, isWritable: true };
    refused([ix], "relayer-in-accounts");
    const open = await openMatchIx(relayer, player, game);
    const basket = open.keys.findIndex((k) => k.pubkey.equals(open.keys[10].pubkey));
    open.keys[basket] = { pubkey: relayer, isSigner: false, isWritable: true };
    refused([open], "relayer-in-accounts");
  });
  it("an extra account on an instruction that takes none", async () => {
    const close = await coreIx("close_ticket", [], { caller: relayer, ticket: key(), payer: relayer });
    close.keys.push({ pubkey: key(), isSigner: false, isWritable: false });
    refused([close], "bad-accounts");
  });
  it("more Source and store accounts than an open or a join may carry, and a signer among them", async () => {
    for (const make of [openMatchIx, joinMatchIx]) {
      const many = await make(relayer, player, game);
      for (let i = 0; i < 61; i++) many.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
      refused([many], "bad-accounts");
      const signing = await make(relayer, player, game);
      signing.keys.push({ pubkey: key(), isSigner: true, isWritable: true });
      refused([signing], "bad-accounts");
    }
  });
  it("more chunk accounts than the row allows, and a signer among them", async () => {
    refused([await chunkIx(relayer, key(), 61)], "bad-accounts");
    const ix = await chunkIx(relayer, key(), 2);
    ix.keys[ix.keys.length - 1].isSigner = true;
    refused([ix], "bad-accounts");
  });
  it("a wrong signer or writable flag", async () => {
    const open = await openMatchIx(relayer, player, game);
    open.keys[1].isSigner = false;
    refused([open], "bad-flags");
    const open2 = await openMatchIx(relayer, player, game);
    open2.keys[2].isWritable = true;
    refused([open2], "bad-flags");
  });
  it("a PDA that is not the one the program derives", async () => {
    const open = await openMatchIx(relayer, player, game);
    open.keys[11] = { ...open.keys[11], pubkey: key() };
    refused([open], "bad-account");
  });
  it("the Player's own Account swapped for another Account", async () => {
    const other = key();
    const open = await openMatchIx(relayer, player, game, { playerAccount: other });
    refused([open], "bad-account");
  });
  it("unknown programs: System transfer, compute budget, an unlisted Game", async () => {
    refused([SystemProgram.transfer({ fromPubkey: relayer, toPubkey: player, lamports: 1 })], "unknown-program");
    refused([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })], "unknown-program");
    refused([{ programId: key(), keys: [], data: new Uint8Array([1]) }], "unknown-program");
  });
  it("Core instructions that are not in the table, and unknown discriminators", async () => {
    refused([await coreIx("set_sponsor", [relayer, false, new BN(1), new BN(1), new BN(1)], { admin: player })], "unknown-instruction");
    refused([{ programId: CORE_ID, keys: [], data: new Uint8Array(8) }], "unknown-instruction");
  });
  it("a Game instruction naming the relayer, or signed by someone else", () => {
    const base = { programId: game, data: new Uint8Array([1]) };
    refused([{ ...base, keys: [{ pubkey: relayer, isSigner: false, isWritable: false }] }], "relayer-in-accounts");
    refused([{ ...base, keys: [{ pubkey: key(), isSigner: true, isWritable: false }] }], "bad-signer");
  });
  it("shapes the table does not list: an open never travels with a grow, grows never follow a join", async () => {
    const open = await openMatchIx(relayer, player, game);
    refused([open, open], "bad-shape");
    const grow = await growIx(relayer, key());
    expect(plan([grow]).class).toBe("admission");
    refused([grow, open], "bad-shape");
    refused([await joinMatchIx(relayer, player, game), grow], "bad-shape");
    refused([grow, grow, grow, grow, grow, grow], "bad-shape");
  });
  it("a join may be preceded by the grows of the Accounts it holds room in (ticket 09b)", async () => {
    const join = await joinMatchIx(relayer, player, game);
    const alone = plan([join]);
    expect(alone.names).toEqual(["join_match"]);
    for (let n = 1; n <= 5; n++) {
      const grows = await Promise.all(Array.from({ length: n }, () => growIx(relayer, key())));
      const p = plan([...grows, join]);
      expect(p.names).toEqual([...Array(n).fill("grow_store_sponsored"), "join_match"]);
      expect(p.class).toBe("admission");
      expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
      expect(p.spend.refundable).toBeGreaterThan(alone.spend.refundable);
      expect(p.cu).toBeLessThanOrEqual(1_400_000);
    }
  });
  it("grows alone are a shape, and the relayer is only the grow's relayer slot", async () => {
    expect(plan([await growIx(relayer, key()), await growIx(relayer, key())]).names).toHaveLength(2);
    const grow = await growIx(relayer, key());
    const account = grow.keys.findIndex((k) => !k.isSigner && !k.isWritable && !k.pubkey.equals(CORE_ID) && !k.pubkey.equals(relayer));
    grow.keys[account] = { ...grow.keys[account], pubkey: relayer };
    refused([grow], "relayer-in-accounts");
  });
  it("empty and oversized transactions", async () => {
    refused([], "bad-shape");
    const open = await openMatchIx(relayer, player, game);
    refused(Array(5).fill(open), "bad-shape");
  });
});

describe("the Player's own exits and orders (ticket 18b)", () => {
  const exits = {
    redeem: playerIx.redeem,
    redeem_prize: playerIx.redeemPrize,
    unlock: playerIx.unlock,
    cancel_instant_redeem: (a: typeof player) => playerIx.cancelInstantRedeem(a),
    expire_instant_redeem: (a: typeof player) => playerIx.expireInstantRedeem(a),
    cancel_offer: (a: typeof player) => playerIx.cancelOffer(a),
    cancel_request: (a: typeof player) => playerIx.cancelRequest(a),
    claim_free_yield: playerIx.claimFreeYield,
  };
  for (const [name, build] of Object.entries(exits)) {
    it(`${name}: an exit signed by the Player, the relayer is only the fee payer`, async () => {
      const p = plan([await build(player)]);
      expect(p).toMatchObject({ names: [name], class: "exit" });
      expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
      expect(p.playerSigns).toBe(true);
    });
    it(`${name}: refuses an extra account and the relayer in any account`, async () => {
      const ix0 = await build(player);
      const extra = { ...ix0, keys: [...ix0.keys, { pubkey: key(), isSigner: true, isWritable: false }] };
      refused([extra], "bad-accounts");
      const ix = await build(player);
      const i = ix.keys.findIndex((k) => k.isWritable && !k.isSigner);
      ix.keys[i] = { pubkey: relayer, isSigner: false, isWritable: true };
      refused([ix], "relayer-in-accounts");
      const asSigner = await build(player);
      asSigner.keys[0] = { pubkey: relayer, isSigner: true, isWritable: asSigner.keys[0].isWritable };
      refused([asSigner], "relayer-in-accounts");
    });
  }
  it("redeem may carry the books of the Sources it touches, never a signer", async () => {
    const ix = await playerIx.redeem(player);
    ix.keys.push({ pubkey: key(), isSigner: false, isWritable: true }, { pubkey: key(), isSigner: false, isWritable: false });
    expect(plan([ix]).names).toEqual(["redeem"]);
    ix.keys.push({ pubkey: key(), isSigner: true, isWritable: false });
    refused([ix], "bad-accounts");
  });
  it("request_instant_redeem: the holder pays, or the relayer pays and the sponsor repays it", async () => {
    const own = plan([await playerIx.requestInstantRedeem(player)]);
    expect(own).toMatchObject({ names: ["request_instant_redeem"], class: "admission" });
    const sponsored = plan([await playerIx.requestInstantRedeem(player, relayer, true)]);
    expect(sponsored.spend.refundable).toBe(ORDER_RENT);
    expect(sponsored.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
    // the relayer never pays an order's rent without the sponsor account to repay it, or stands anywhere else
    refused([await playerIx.requestInstantRedeem(player, relayer, false)], "bad-accounts");
    const holder = await playerIx.requestInstantRedeem(relayer, relayer, true);
    refused([holder], "relayer-in-accounts");
  });
  it("cancel and expire may name the relayer as the order's payer only with the sponsor account", async () => {
    for (const make of [playerIx.cancelInstantRedeem, playerIx.expireInstantRedeem]) {
      expect(plan([await make(player, key(), relayer, true)]).class).toBe("exit");
      refused([await make(player, key(), relayer, false)], "bad-accounts");
    }
  });
  it("an exit cannot ride along with another instruction", async () => {
    refused([await playerIx.unlock(player), await playerIx.unlock(player)], "bad-shape");
  });
});

describe("a Backing Ticket opened and staged in one transaction", () => {
  it("is an admission signed by the Requester alone, and names whose lines fund it", async () => {
    const { ixs, requester, backerAccount } = await backingPairIx(relayer);
    const p = plan(ixs);
    expect(p).toMatchObject({ names: ["open_ticket", "stage_entry"], class: "admission" });
    expect(p.signers.map((k) => k.toBase58())).toEqual([requester.toBase58()]);
    expect(p.funders.map((k) => k.toBase58())).toEqual([backerAccount.toBase58()]);
  });
  it("is refused when stage_entry is for another Ticket or another Account", async () => {
    const a = await backingPairIx(relayer);
    a.ixs[1].keys[4] = { ...a.ixs[1].keys[4], pubkey: key() };
    refused(a.ixs, "bad-shape");
    const b = await backingPairIx(relayer);
    const other = await backingPairIx(relayer);
    b.ixs[1] = other.ixs[1];
    refused(b.ixs, "bad-shape");
  });
  it("is refused with the relayer, or anyone but the Requester, as the signer of stage_entry", async () => {
    const a = await backingPairIx(relayer);
    a.ixs[1].keys[0] = { pubkey: relayer, isSigner: true, isWritable: false };
    refused(a.ixs, "relayer-in-accounts");
    const b = await backingPairIx(relayer);
    b.ixs[1].keys[0] = { pubkey: key(), isSigner: true, isWritable: false };
    refused(b.ixs, "bad-shape");
  });
});
