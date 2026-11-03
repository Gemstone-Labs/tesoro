import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { CreditMeter, meteredFetch } from "./credits.ts";
import { newConnection } from "./runtime.ts";

const PROGRAM = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const ACCOUNT = new PublicKey("11111111111111111111111111111111");

/** A Helius-looking endpoint that serves getProgramAccountsV2 in two pages and records every method it is asked. */
function heliusFake() {
  const methods: string[] = [];
  const fake = (async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    methods.push(method);
    if (method !== "getProgramAccountsV2") return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: null }));
    const page2 = params[1].paginationKey === "next";
    const accounts = [{ pubkey: ACCOUNT.toBase58(), account: { data: ["AQID", "base64"], lamports: 1, owner: PROGRAM.toBase58(), executable: false } }];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { accounts, paginationKey: page2 ? null : "next" } }));
  }) as typeof fetch;
  return { methods, fake };
}

describe("the keeper connection's program account lists", () => {
  it("pages through getProgramAccountsV2 and never sends a plain getProgramAccounts on a mainnet-guarded fetch", async () => {
    const { methods, fake } = heliusFake();
    const guarded = meteredFetch(fake, new CreditMeter(), { mainnet: () => true });
    const conn = newConnection("https://mainnet.helius-rpc.com/?api-key=x", "https://mainnet.helius-rpc.com/?api-key=x", guarded);
    const rows = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 3 }] });
    assert.equal(rows.length, 2);
    assert.deepEqual([...rows[0].account.data], [1, 2, 3]);
    assert.deepEqual(methods, ["getProgramAccountsV2", "getProgramAccountsV2"]);
  });
});
