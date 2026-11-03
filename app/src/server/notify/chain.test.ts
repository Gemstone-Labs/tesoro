import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../games/block-puzzle/chain";
import { rpcNotifyChain } from "./chain";
import { key } from "./test-tx";

const accounts = new anchor.BorshAccountsCoder(coreIdl as anchor.Idl);
const bytes = (k: string) => [...new PublicKey(k).toBytes()];

/** A JSON-RPC server with these accounts (base64 data); counts getAccountInfo calls. */
function server(data: Record<string, Buffer>) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string] };
    calls.push(params[0]);
    const d = data[params[0]];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: d ? { data: [d.toString("base64"), "base64"], owner: "x", lamports: 1, executable: false } : null } }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("reading accounts for notifications", () => {
  it("reads the wallet of an Account once", async () => {
    const data = await accounts.encode("TesoroAccount", { bump: 1, authority: new PublicKey(key(5)), evm_address: new Array(20).fill(0) });
    const s = server({ [key(1)]: data });
    const chain = rpcNotifyChain("http://rpc", s.fetchFn);
    expect(await chain.authorityOfAccount(key(1))).toBe(key(5));
    expect(await chain.authorityOfAccount(key(1))).toBe(key(5));
    expect(s.calls).toEqual([key(1)]);
    expect(await chain.authorityOfAccount(key(2))).toBeNull();
  });

  it("reads an Offer and a Request", async () => {
    const game = BLOCK_PUZZLE_PROGRAM_ID;
    const offer = await accounts.encode("OfferState", {
      bump: 1, nonce: new anchor.BN(1),
      inner: { backer: bytes(key(6)), game: [...game.toBytes()], entry: new anchor.BN(250), player_share_bps: 5000, request: bytes(key(7)), status: { Open: {} }, expires_at: new anchor.BN(1), use_by: new anchor.BN(2), player: null, ticket_open: false },
    });
    const request = await accounts.encode("RequestState", {
      bump: 1, nonce: new anchor.BN(1),
      inner: { player: bytes(key(8)), game: [...game.toBytes()], entry: new anchor.BN(250), expires_at: new anchor.BN(1), status: { Open: {} } },
    });
    const chain = rpcNotifyChain("http://rpc", server({ [key(10)]: offer, [key(11)]: request }).fetchFn);
    expect(await chain.offer(key(10))).toEqual({ backer: key(6), request: key(7), game: "block-puzzle", entry: 250 });
    expect(await chain.request(key(11))).toEqual({ player: key(8), game: "block-puzzle", entry: 250 });
    expect(await chain.offer(key(12))).toBeNull();
  });

  it("reads a Position's owner and Lock asset in both layouts", async () => {
    const position = (size: number, chainByte: number) => {
      const b = Buffer.alloc(size);
      new PublicKey(key(9)).toBuffer().copy(b, 41);
      b[73] = chainByte;
      return b;
    };
    const chain = rpcNotifyChain("http://rpc", server({ [key(20)]: position(243, 1), [key(21)]: position(235, 2), [key(22)]: position(243, 0) }).fetchFn);
    expect(await chain.position(key(20))).toEqual({ owner: key(9), asset: "ETH" });
    expect(await chain.position(key(21))).toEqual({ owner: key(9), asset: "HYPE" });
    expect(await chain.position(key(22))).toEqual({ owner: key(9), asset: "SOL" });
  });
});
