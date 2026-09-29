import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { BASE_RPC, BlockPuzzleChain, keypairSigner } from "../../../app/src/games/block-puzzle/chain";

const ROOT = path.join(__dirname, "../../..");
const bpIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/block_puzzle.json"), "utf8"));
const coreIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/tesoro_core.json"), "utf8"));
const chain = new BlockPuzzleChain({ base: new Connection(BASE_RPC, "confirmed"), blockPuzzleIdl: bpIdl, coreIdl });
const kp = Keypair.fromSecretKey(bs58.decode(process.argv[3]));
(async () => {
  const me = BlockPuzzleChain.coreAccount(kp.publicKey);
  const all = await (chain.core.account as any).holdingState.all([{ memcmp: { offset: 9, bytes: me.toBase58() } }]);
  const mine = all;
  console.log("holdings", mine.map((h: any) => h.publicKey.toBase58()));
  try {
    console.log(await chain.joinMatch(keypairSigner(kp), BigInt(process.argv[2]), [mine[0].publicKey]));
  } catch (e: any) {
    console.log(String(e.message).slice(0, 2000));
  }
})();
