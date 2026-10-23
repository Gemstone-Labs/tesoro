import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { PYTH_FEED_IDS as APP_FEED_IDS, onchainPricePda, pythFeedAddress, treasuryAccountPda, treasuryPda } from "../../app/src/lib/chain/native.ts";
import { JITOSOL, initTreasuryStakeIx, setStakeApyCeilingIx, setStakeTokenIx } from "../../app/src/lib/chain/stake.ts";
import { PROGRAMS } from "./mainnet-keys.ts";
import {
  KHYPE,
  PRICE_ASSET_KEYS,
  PYTH_FEED_IDS,
  STEP_NAMES,
  WSTETH,
  buildLaunchPlan,
  codeHash,
  configPda,
  coreAccountPda,
  describeStep,
  evmAssetKey,
  gameAuthorityPda,
  gameRecordPda,
  programDataPda,
  pythFeedAccount,
  type LaunchInput,
  type PlanStep,
} from "./launch-admin.ts";

const idl = coreIdl as unknown as { instructions: { name: string; accounts: { name: string; signer?: boolean; writable?: boolean; address?: string }[] }[] };
const coder = new anchor.BorshInstructionCoder(coreIdl as unknown as Idl);
const k = () => Keypair.generate().publicKey;
const CORE = new PublicKey(PROGRAMS.tesoro_core);

const input = (): LaunchInput => ({
  admin: k(),
  vault: k(),
  oracle: k(),
  platformBps: 200,
  company: k(),
  invite: k(),
  games: [
    { name: "block_puzzle", studio: k(), studioBps: 300 },
    { name: "holdem", studio: k(), studioBps: 300 },
    { name: "trading_duel", studio: k(), studioBps: 300 },
  ],
});

const decode = (step: PlanStep) => step.ixs.map((ix) => coder.decode(ix.data)!);
const named = (steps: PlanStep[], name: string) => steps.filter((s) => s.name === name);

test("the plan is in runbook order and covers every launch call", () => {
  const steps = buildLaunchPlan(input());
  const order = steps.filter((s) => s.name !== "note").map((s) => s.ixs[0] ? coder.decode(s.ixs[0].data)!.name : s.name);
  assert.deepEqual(order, [
    "create_account",
    "initialize_config",
    "init_treasury_stake",
    "set_stake_token",
    "set_stake_apy_ceiling",
    "set_onchain_price",
    "set_onchain_price",
    "set_onchain_price",
    "set_entry_sizes",
    "register_game",
    "register_game",
    "register_game",
    "init_leaderboard",
    "set_treasury_company",
    "set_source_authority",
    "set_source_authority",
    "whitelist",
    "set_invite_gate",
  ]);
  assert.equal(STEP_NAMES[STEP_NAMES.length - 1], "invite-gate");
});

test("every instruction matches the IDL: account order, signer and writable flags, fixed addresses", () => {
  for (const step of buildLaunchPlan(input())) {
    for (const ix of step.ixs) {
      const def = idl.instructions.find((i) => i.name === coder.decode(ix.data)!.name)!;
      assert.equal(ix.keys.length, def.accounts.length, def.name);
      def.accounts.forEach((a, i) => {
        // An optional account nobody named is "none": the program's own id, read-only.
        if ((a as { optional?: boolean }).optional && ix.keys[i].pubkey.equals(CORE)) {
          assert.equal(ix.keys[i].isWritable, false, `${def.name}.${a.name} none`);
          return;
        }
        assert.equal(ix.keys[i].isSigner, !!a.signer, `${def.name}.${a.name} signer`);
        assert.equal(ix.keys[i].isWritable, !!a.writable, `${def.name}.${a.name} writable`);
        if (a.address) assert.equal(ix.keys[i].pubkey.toBase58(), a.address);
      });
      assert.ok(ix.programId.equals(CORE));
    }
  }
});

test("Treasury, stake token and APY ceiling equal the app builders byte for byte", () => {
  const i = input();
  const steps = buildLaunchPlan(i);
  const same = (a: { keys: unknown[]; data: Buffer }, b: { keys: unknown[]; data: Buffer }) => {
    assert.deepEqual(JSON.parse(JSON.stringify(a.keys)), JSON.parse(JSON.stringify(b.keys)));
    assert.equal(a.data.toString("hex"), b.data.toString("hex"));
  };
  same(named(steps, "treasury")[0].ixs[0], initTreasuryStakeIx(i.admin, 2000, 2500));
  same(named(steps, "stake-token")[0].ixs[0], setStakeTokenIx(i.admin, JITOSOL));
  same(named(steps, "apy-ceiling")[0].ixs[0], setStakeApyCeilingIx(i.admin, 800));
  assert.ok(named(steps, "treasury")[0].ixs[0].keys[3].pubkey.equals(treasuryAccountPda()));
  assert.ok(named(steps, "treasury")[0].ixs[0].keys[2].pubkey.equals(treasuryPda()));
});

test("defaults: Yield Fee 20%, Instant Redeem Fee 25%, ceiling 800, entries 100/500/1000, Leaderboard 100", () => {
  const steps = buildLaunchPlan(input());
  assert.deepEqual(decode(named(steps, "treasury")[0])[0].data, { yield_fee_bps: 2000, instant_fee_bps: 2500 });
  assert.equal((decode(named(steps, "apy-ceiling")[0])[0].data as { apy_ceiling_bps: number }).apy_ceiling_bps, 800);
  const sizes = (decode(named(steps, "entry-sizes")[0])[0].data as { sizes: { toNumber(): number }[] }).sizes.map((s) => s.toNumber());
  assert.deepEqual(sizes, [100, 500, 1000]);
  assert.equal((decode(named(steps, "leaderboard")[0])[0].data as { leaderboard_bps: number }).leaderboard_bps, 100);
});

test("the Pyth feed ids are the full ids, equal the app's, and map to the documented feed accounts", () => {
  assert.deepEqual(PYTH_FEED_IDS, APP_FEED_IDS);
  for (const id of Object.values(PYTH_FEED_IDS)) assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(pythFeedAccount("SOL").toBase58(), "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
  assert.equal(pythFeedAccount("ETH").toBase58(), "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");
  assert.equal(pythFeedAccount("HYPE").toBase58(), "6usXZCEM4kf1KHGDTzgQLAWtDMNdzLjfAUYSwGKJm19Y");
  for (const a of ["SOL", "ETH", "HYPE"] as const) assert.ok(pythFeedAccount(a).equals(pythFeedAddress(a)));
});

test("set_onchain_price maps jitoSOL, wstETH and kHYPE keys to their feed, id and limits", () => {
  const steps = named(buildLaunchPlan(input()), "prices");
  assert.equal(steps.length, 3);
  const assets = ["SOL", "ETH", "HYPE"] as const;
  steps.forEach((s, i) => {
    const a = assets[i];
    const ix = s.ixs[0];
    const d = coder.decode(ix.data)!.data as { asset: PublicKey; feed_id: number[]; max_age_secs: number; max_conf_bps: number };
    assert.ok(d.asset.equals(PRICE_ASSET_KEYS[a].key));
    assert.equal(Buffer.from(d.feed_id).toString("hex"), PYTH_FEED_IDS[a]);
    assert.equal(d.max_age_secs, 90);
    assert.equal(d.max_conf_bps, 100);
    assert.ok(ix.keys[2].pubkey.equals(onchainPricePda(PRICE_ASSET_KEYS[a].key)));
    assert.ok(ix.keys[3].pubkey.equals(pythFeedAccount(a)));
  });
  assert.equal(PRICE_ASSET_KEYS.SOL.key.toBase58(), JITOSOL.mint.toBase58());
  assert.equal(evmAssetKey(WSTETH).toBuffer().subarray(0, 12).every((b) => b === 0), true);
  assert.equal(evmAssetKey(KHYPE).toBuffer().subarray(12).toString("hex"), KHYPE.slice(2).toLowerCase());
  assert.throws(() => evmAssetKey("0x1234"), /not an EVM address/);
});

test("initialize_config points the fee recipient at the vault's Account and carries the front-run caveat", () => {
  const i = input();
  const [cfg] = named(buildLaunchPlan(i), "config");
  const ix = cfg.ixs[0];
  assert.ok(ix.keys[0].pubkey.equals(i.admin) && ix.keys[0].isSigner);
  assert.ok(ix.keys[1].pubkey.equals(configPda(CORE)));
  assert.ok(ix.keys[2].pubkey.equals(coreAccountPda(CORE, i.vault)));
  assert.deepEqual(coder.decode(ix.data)!.data, { oracle_authority: i.oracle, platform_bps: 200 });
  assert.match(cfg.why, /SAME SESSION/);
  assert.match(cfg.why, /Config\.admin/);
});

test("the vault's Account and the Invite gate are proposals for the vault; the rest is the admin's single key", () => {
  const i = input();
  const steps = buildLaunchPlan(i);
  assert.equal(named(steps, "vault-account")[0].proposal, true);
  assert.ok(named(steps, "vault-account")[0].ixs[0].keys[0].pubkey.equals(i.vault));
  for (const s of steps.filter((x) => x.signer && x.name !== "vault-account")) assert.equal(s.proposal, false, s.title);
  const after = buildLaunchPlan({ ...i, admin: i.vault, oracle: i.oracle });
  for (const s of after.filter((x) => x.signer)) assert.equal(s.proposal, true, s.title);
});

test("set_invite_gate is the last instruction and turns the gate on with the Invite key", () => {
  const i = input();
  const steps = buildLaunchPlan(i).filter((s) => s.ixs.length);
  const last = steps[steps.length - 1];
  assert.equal(last.name, "invite-gate");
  assert.deepEqual(coder.decode(last.ixs[0].data)!.data, { required: true, key: i.invite });
  assert.ok(steps.findIndex((s) => s.name === "vault-account") < steps.length - 1);
});

test("register_game is signed by the program's upgrade authority and names the settle authority PDA, ProgramData and Studio Account", () => {
  const i = input();
  const control = k();
  i.games![0].control = control;
  const ids = { block_puzzle: k().toBase58() };
  const steps = named(buildLaunchPlan({ ...i, programs: ids }), "games");
  const game = new PublicKey(ids.block_puzzle);
  const d = decode(steps[0])[0].data as { settle_authority: PublicKey; studio_bps: number };
  assert.ok(d.settle_authority.equals(gameAuthorityPda(game)));
  assert.equal(d.studio_bps, 300);
  assert.ok(steps[0].signer!.equals(control));
  const keys = steps[0].ixs[0].keys;
  assert.ok(keys[0].pubkey.equals(control) && keys[1].pubkey.equals(control), "control pays and signs");
  assert.ok(keys[3].pubkey.equals(game));
  assert.ok(keys[4].pubkey.equals(programDataPda(game)));
  assert.ok(keys[5].pubkey.equals(coreAccountPda(CORE, i.games![0].studio)));
  assert.ok(keys[6].pubkey.equals(gameRecordPda(CORE, game)));
  assert.ok(steps[1].signer!.equals(i.admin), "a game without a control key is signed by the admin");
});

test("list_game is an admin step carrying the build hash, and only appears with one", () => {
  const i = input();
  assert.equal(named(buildLaunchPlan(i), "games").length, 3);
  const hash = codeHash(Buffer.concat([Buffer.alloc(45), Buffer.from([1, 2, 3]), Buffer.alloc(10_240)]));
  assert.equal(hash, createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex"), "trailing zeros are not part of the build");
  i.games![1].approvedHash = hash;
  i.games![1].listedUntil = 1_800_000_000;
  const steps = named(buildLaunchPlan(i), "games");
  assert.equal(steps.length, 4);
  const list = steps[2];
  assert.ok(list.signer!.equals(i.admin));
  const dec = decode(list)[0];
  assert.equal(dec.name, "list_game");
  const data = dec.data as { listed_until: { toNumber(): number }; approved_hash: number[] };
  assert.equal(data.listed_until.toNumber(), 1_800_000_000);
  assert.equal(Buffer.from(data.approved_hash).toString("hex"), hash);
  i.games![1].approvedHash = "abc";
  assert.throws(() => buildLaunchPlan(i), /64 hex/);
  i.games![1].approvedHash = hash;
  i.games![1].listedUntil = undefined;
  assert.throws(() => buildLaunchPlan(i), /listed-until/);
});

test("Source authorities are the bridge authority PDA for Ethereum (1) and HyperEVM (2)", () => {
  const steps = named(buildLaunchPlan(input()), "sources");
  const bridgeAuth = PublicKey.findProgramAddressSync([Buffer.from("authority")], new PublicKey(PROGRAMS.tesoro_bridge))[0];
  [1, 2].forEach((byte, idx) => {
    const ix = steps[idx].ixs[0];
    assert.ok(ix.keys[2].pubkey.equals(PublicKey.findProgramAddressSync([Buffer.from("source_auth"), Buffer.from([byte])], CORE)[0]));
    assert.equal(ix.data[8], byte);
    assert.ok(new PublicKey(ix.data.subarray(9, 41)).equals(bridgeAuth));
  });
});

test("step selection runs only the named steps; missing inputs and bad values are refused", () => {
  const i = input();
  assert.deepEqual(buildLaunchPlan({ ...i, steps: ["treasury", "apy-ceiling"] }).map((s) => s.name), ["treasury", "apy-ceiling"]);
  assert.throws(() => buildLaunchPlan({ admin: i.admin, vault: i.vault }), /--oracle.*--platform-bps/);
  assert.throws(() => buildLaunchPlan({ ...i, entrySizes: [150] }), /multiples of 100/);
  assert.throws(() => buildLaunchPlan({ ...i, apyCeilingBps: 0 }), /apy-ceiling/);
  assert.throws(() => buildLaunchPlan({ ...i, oracle: i.admin }), /own hot key/);
  assert.throws(() => buildLaunchPlan({ ...i, invite: i.oracle }), /--invite must differ/);
  assert.throws(() => buildLaunchPlan({ ...i, platformBps: 20_000 }), /platform-bps/);
});

test("describeStep names every account, shows the signer, data and the Squads note, without key material", () => {
  const out = buildLaunchPlan(input()).map(describeStep).join("\n");
  assert.match(out, /SUBMIT AS A SQUADS PROPOSAL/);
  assert.match(out, /platform_recipient/);
  assert.match(out, /data \(base64\)/);
  assert.ok(!/secret key|private key/i.test(out));
});
