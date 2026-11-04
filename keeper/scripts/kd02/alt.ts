// kd-02: reads the bridge's LzReceiveTypes PDA (its `alt` field) and dumps any lookup table named on the command line.
import { Connection, PublicKey, AddressLookupTableAccount } from "@solana/web3.js";
import { BRIDGE, STORE } from "../../src/lz.ts";
const conn = new Connection(process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet", "confirmed");
const lzTypes = PublicKey.findProgramAddressSync([Buffer.from("LzReceiveTypes"), STORE.toBuffer()], BRIDGE)[0];
const info = await conn.getAccountInfo(lzTypes);
console.log("LzReceiveTypes PDA", lzTypes.toBase58(), "bytes", info?.data.length);
const alt = info ? new PublicKey(info.data.subarray(8 + 32, 8 + 64)) : null;
console.log("alt field", alt?.toBase58(), alt?.equals(BRIDGE) ? "(= bridge program id = None)" : "");
for (const a of [alt?.toBase58(), ...process.argv.slice(2)].filter((x) => x && x !== "11111111111111111111111111111111") as string[]) {
  const r = await conn.getAddressLookupTable(new PublicKey(a));
  const t: AddressLookupTableAccount | null = r.value;
  console.log("ALT", a, t ? `${t.state.addresses.length} addresses, authority ${t.state.authority?.toBase58()}` : "not found");
  t?.state.addresses.forEach((k, i) => console.log(" ", i, k.toBase58()));
}
