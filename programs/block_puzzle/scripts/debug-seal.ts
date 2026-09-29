import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { BASE_RPC, BlockPuzzleChain } from "../../../app/src/games/block-puzzle/chain";

const a = BlockPuzzleChain.addresses(BigInt(process.argv[2]));
const base = new Connection(BASE_RPC, "confirmed");
const ROOT = path.join(__dirname, "../../..");
(async () => {
  for (const [n, k] of [["board0", a.boards[0]], ["board1", a.boards[1]], ["vault", a.vault]] as const) {
    const i = await base.getAccountInfo(k);
    console.log(n, k.toBase58(), i?.owner.toBase58(), i?.data.length);
  }
  const bpIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/block_puzzle.json"), "utf8"));
  const prov = new AnchorProvider(base, { publicKey: a.session, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t }, {});
  const bp: any = new Program(bpIdl, prov);
  const s = await bp.account.session.fetch(a.session);
  console.log(JSON.stringify(s));
  const core: any = new Program(JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/tesoro_core.json"), "utf8")), prov);
  const m = await core.account.matchState.fetch(a.match);
  console.log(JSON.stringify({ status: m.inner.status, b: !!m.inner.b, deadline: m.inner.deadline.toString() }));
})();
