import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionResult, type Abi } from "viem";
import { vaultAbi } from "./eth";

const artifact = resolve(__dirname, "../../../../contracts/out/PositionVault.sol/PositionVault.json");

describe("vaultAbi matches the formula vault (contracts/src/PositionVault.sol)", () => {
  it.skipIf(!existsSync(artifact))("getPosition has the compiled struct, field for field", () => {
    const compiled = JSON.parse(readFileSync(artifact, "utf8")).abi as Abi;
    const get = (abi: Abi) => (abi.find((f) => f.type === "function" && f.name === "getPosition") as unknown as { outputs: { components: { name: string; type: string }[] }[] }).outputs[0].components.map((c) => `${c.name}:${c.type}`);
    expect(get(vaultAbi as unknown as Abi)).toEqual(get(compiled));
  });

  it.skipIf(!existsSync(artifact))("every function the app calls exists on the vault", () => {
    const compiled = JSON.parse(readFileSync(artifact, "utf8")).abi as Abi;
    const names = new Set(compiled.filter((f) => f.type === "function").map((f) => (f as { name: string }).name));
    // quote* live on PositionVaultOApp
    const onOApp = new Set(["quotePositionLocked", "quoteYieldAccrued", "quoteInstantRefund"]);
    for (const f of vaultAbi) if (f.type === "function" && !onOApp.has(f.name)) expect(names.has(f.name), f.name).toBe(true);
  });

  it("decodes a Position as named fields", () => {
    const p = {
      owner: "0x00000000000000000000000000000000000A11cE", principalShares: 10n, principalUnderlying: 12n, openRate: 1n, paidUnderlying: 2n, frozenAccrued: 3n,
      a: 4n, b: 5n, d: 6n, heldShares: 7n, apyBps: 0n, speedup: 0n, openTime: 8n, outSeq: 1n, inSeq: 0n, feeBps: 2000, horizonMonths: 12, unlocked: false,
    } as const;
    const data = encodeFunctionResult({ abi: vaultAbi, functionName: "getPosition", result: p });
    const out = decodeFunctionResult({ abi: vaultAbi, functionName: "getPosition", data });
    expect(out).toEqual(p);
  });
});
