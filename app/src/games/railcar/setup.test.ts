import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { authorityPda } from "./chain";
import { railcarSetupPlan, rentOf, setupProblems, withPending, type SetupFacts, type SetupInput } from "./setup";

const key = () => Keypair.generate().publicKey;
const deployer = key();
const input: SetupInput = {
  upgradeAuthority: deployer,
  admin: deployer,
  operator: key(),
  validator: new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"),
  studioAccount: key(),
  studioBps: 300,
  tables: 2,
  sponsorLamports: 100_000_000n,
  fuelLamports: 50_000_000n,
  fuel: 0,
  listedDays: 365,
  now: 1_800_000_000,
};
const hash = Buffer.alloc(32, 7);
const nothing: SetupFacts = {
  coreConfig: { admin: deployer, entries: [100n, 500n, 1_000n] },
  tesoroStudio: input.studioAccount,
  studioAccountExists: true,
  program: { slot: 519_983_000n, authority: deployer, hash },
  game: null,
  approvedValidators: null,
  config: null,
  sponsor: "missing",
  fuel: "missing",
  tables: [
    { index: 0, base: "missing", vaultReady: null },
    { index: 1, base: "missing", vaultReady: null },
  ],
};
const everything: SetupFacts = {
  ...nothing,
  game: { settleAuthority: authorityPda(), studioBps: 300, studioRecipient: input.studioAccount, listedUntil: input.now + 86_400, approvedSlot: 519_983_000n, approvedHash: hash },
  approvedValidators: [input.validator],
  config: { operator: input.operator, tables: 2, nextCar: 0n },
  sponsor: "delegated",
  fuel: "delegated",
  tables: [
    { index: 0, base: "delegated", vaultReady: true },
    { index: 1, base: "delegated", vaultReady: true },
  ],
};

describe("Railcar's setup plan", () => {
  it("on a chain with nothing set up, every step is to do, in the order the script sends them", () => {
    const steps = railcarSetupPlan(input, nothing);
    expect(steps.map((s) => [s.id, s.status, s.signer, s.layer])).toEqual([
      ["register-game", "to do", "upgrade authority", "base"],
      ["list-game", "to do", "admin", "base"],
      ["tee-only", "to do", "upgrade authority", "base"],
      ["set-config", "to do", "upgrade authority", "base"],
      ["create-sponsor", "to do", "operator", "base"],
      ["create-fuel-0", "to do", "operator", "base"],
      ["delegate-sponsor", "to do", "operator", "base"],
      ["delegate-fuel-0", "to do", "operator", "base"],
      ["create-table-0", "to do", "operator", "base"],
      ["delegate-table-0", "to do", "operator", "base"],
      ["create-table-1", "to do", "operator", "base"],
      ["delegate-table-1", "to do", "operator", "base"],
      ["init-vault-0", "to do", "operator", "rollup"],
      ["init-vault-1", "to do", "operator", "rollup"],
    ]);
    expect(setupProblems(input, nothing)).toEqual([]);
  });

  it("on a chain that holds all of it, nothing is left to send", () => {
    expect(railcarSetupPlan(input, everything).filter((s) => s.status !== "done")).toEqual([]);
  });

  it("re-lists a build that changed since it was listed", () => {
    const steps = railcarSetupPlan(input, { ...everything, program: { ...everything.program!, slot: 520_000_000n, hash: Buffer.alloc(32, 8) } });
    expect(steps.filter((s) => s.status !== "done").map((s) => s.id)).toEqual(["list-game"]);
  });

  it("refuses a Table count other than the one fixed when the first car opened", () => {
    const steps = railcarSetupPlan({ ...input, tables: 3 }, { ...everything, config: { operator: input.operator, tables: 2, nextCar: 4n }, tables: [...everything.tables, { index: 2, base: "missing", vaultReady: null }] });
    expect(steps.find((s) => s.id === "set-config")!.status).toBe("blocked");
  });

  it("a dry run simulates a step with the steps it needs that are not on chain yet in front of it", () => {
    const steps = railcarSetupPlan(input, nothing);
    expect(withPending(steps, steps.find((s) => s.id === "delegate-table-1")!).map((s) => s.id)).toEqual(["set-config", "create-table-1", "tee-only", "delegate-table-1"]);
    const partly = railcarSetupPlan(input, { ...nothing, config: { operator: input.operator, tables: 2, nextCar: 0n }, approvedValidators: [input.validator] });
    expect(withPending(partly, partly.find((s) => s.id === "delegate-table-1")!).map((s) => s.id)).toEqual(["create-table-1", "delegate-table-1"]);
  });

  it("names what stops the setup before any step", () => {
    const other = key();
    expect(
      setupProblems({ ...input, tables: 1 }, { ...nothing, coreConfig: { admin: other, entries: [100n, 1_000n] }, program: { ...nothing.program!, authority: other }, studioAccountExists: false }),
    ).toHaveLength(5);
  });

  it("costs what the rent of each account and the funding add up to", () => {
    const steps = railcarSetupPlan(input, nothing);
    const table = steps.find((s) => s.id === "create-table-0")!;
    expect(table.lamports).toBe(rentOf(8 + 308 + 100 * 88) + 10_000_000n + 5_000n);
    expect(steps.find((s) => s.id === "init-vault-0")!.lamports).toBe(0n);
  });
});
