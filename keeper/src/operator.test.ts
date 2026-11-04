import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Connection, Keypair } from "@solana/web3.js";
import { settings } from "./env.ts";
import { buildRuntime } from "./runtime.ts";

const conn = new Connection("http://127.0.0.1:9");
const payer = Keypair.generate();

function keyFile(kp: Keypair) {
  const path = join(mkdtempSync(join(tmpdir(), "operator-")), "operator.json");
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return path;
}

describe("the table operator key", () => {
  it("is the keeper key when KEEPER_OPERATOR_KEYPAIR is unset", () => {
    const rt = buildRuntime(settings([], {} as NodeJS.ProcessEnv), conn, payer);
    assert.ok(rt.operator.publicKey.equals(payer.publicKey));
    assert.ok(rt.osigner.publicKey.equals(payer.publicKey));
  });

  it("is the key at KEEPER_OPERATOR_KEYPAIR when set, and the keeper key still pays everything else", () => {
    const operator = Keypair.generate();
    const s = settings([], { KEEPER_OPERATOR_KEYPAIR: keyFile(operator) } as NodeJS.ProcessEnv);
    const rt = buildRuntime(s, conn, payer);
    assert.ok(rt.operator.publicKey.equals(operator.publicKey));
    assert.ok(rt.osigner.publicKey.equals(operator.publicKey));
    assert.ok(rt.payer.publicKey.equals(payer.publicKey));
    assert.ok(rt.hsigner.publicKey.equals(payer.publicKey));
  });

  it("refuses a missing operator file instead of falling back to the keeper key", () => {
    const s = settings([], { KEEPER_OPERATOR_KEYPAIR: "/nonexistent/operator.json" } as NodeJS.ProcessEnv);
    assert.throws(() => buildRuntime(s, conn, payer), /ENOENT/);
  });
});

// Every operator-only call goes through the Game adapters (tables, assign, setup, Sponsor refill). A call that signs with the keeper
// key there would be refused on-chain the day the operator is another key.
describe("the Game adapters", () => {
  it("sign with the operator, never the keeper key", () => {
    const src = readFileSync(new URL("./scheduler-games.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /ctx\.hsigner|ctx\.payer|ctx\.signer/, "scheduler-games.ts must use ctx.osigner / ctx.operator");
  });
});
