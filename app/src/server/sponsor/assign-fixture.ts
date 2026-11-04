import coreIdl from "@/lib/chain/idl/tesoro_core.json";

/** An unjoined MatchState: its discriminator and zeros (no second Player). */
export const MATCH_STATE_FIXTURE = (() => {
  const d = Buffer.alloc(2_000);
  d.set(coreIdl.accounts.find((a) => a.name === "MatchState")!.discriminator);
  return d;
})();
