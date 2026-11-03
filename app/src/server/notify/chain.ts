import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { gameOfProgram } from "../../lib/chain/games";
import type { NotifyChain } from "./from-tx";

const accounts = new anchor.BorshAccountsCoder(coreIdl as anchor.Idl);
const key = (v: unknown) => new PublicKey(v as number[]).toBase58();
/** `Position.source_chain` is the first field after the owner: 8 (discriminator) + 1 (bump) + 32 (position_id) + 32 (owner). The same in both Position sizes. */
const POSITION_OWNER = 41;
const ASSET = ["SOL", "ETH", "HYPE"];

/** The account reads the emails need, over plain JSON-RPC. Authorities are remembered (an Account's wallet never changes). */
export function rpcNotifyChain(url: string, fetchFn: typeof fetch = fetch): NotifyChain {
  const wallets = new Map<string, string>();
  async function read(address: string): Promise<Buffer | null> {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "finalized" }] }),
    });
    if (!res.ok) throw new Error(`getAccountInfo failed: ${res.status}`);
    const json = (await res.json()) as { result?: { value: { data: [string, string] } | null }; error?: { message: string } };
    if (json.error) throw new Error(`getAccountInfo failed: ${json.error.message}`);
    const value = json.result?.value;
    return value ? Buffer.from(value.data[0], "base64") : null;
  }
  return {
    async authorityOfAccount(account) {
      const known = wallets.get(account);
      if (known) return known;
      const data = await read(account);
      if (!data) return null;
      const authority = (accounts.decode("TesoroAccount", data).authority as PublicKey).toBase58();
      wallets.set(account, authority);
      return authority;
    },
    async request(address) {
      const data = await read(address);
      if (!data) return null;
      const r = accounts.decode("RequestState", data).inner;
      const game = gameOfProgram(new PublicKey(r.game));
      return game ? { player: key(r.player), game, entry: Number(r.entry.toString()) } : null;
    },
    async offer(address) {
      const data = await read(address);
      if (!data) return null;
      const o = accounts.decode("OfferState", data).inner;
      const game = gameOfProgram(new PublicKey(o.game));
      return game ? { backer: key(o.backer), request: key(o.request), game, entry: Number(o.entry.toString()) } : null;
    },
    async position(address) {
      const data = await read(address);
      if (!data || data.length < POSITION_OWNER + 33) return null;
      return { owner: new PublicKey(data.subarray(POSITION_OWNER, POSITION_OWNER + 32)).toBase58(), asset: ASSET[data[POSITION_OWNER + 32]] ?? "" };
    },
  };
}
