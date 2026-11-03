import { corePositionPda, EID_HYPEREVM } from "../../src/lz.ts";
for (const n of [1, 2, 3]) {
  const pid = Uint8Array.from(Buffer.from(`dd12e37a9c35137be8a4f871507986da4671b20b000000000000000${n}00000000`, "hex"));
  console.log(n, corePositionPda(EID_HYPEREVM, pid).toBase58());
}
