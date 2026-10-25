import "./polyfill";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "./demo-client";
import { openPositionWithAdvance, openStakePositionWithAdvance, type StakeDeposit } from "./native-flow";
import type { StakeToken } from "./stake";

/**
 * What a Player puts in: simSOL on a test cluster, or the staking token (or plain SOL staked into it) on mainnet.
 * `baseUnits` are simSOL base units (9 decimals).
 */
export type OpenDeposit = { from: "simsol"; baseUnits: bigint } | StakeDeposit;

export interface OpenedAdvance {
  /** The transaction that opened the Position (and, for simSOL and a staking token, took the Advance in the same one). */
  signature: string;
  /** The Position's address, base58. */
  position: string;
}

/**
 * Opens a Position and takes its Advance for `months` on the Player's basket: the Gemas land as one General line (planned repayment
 * `now + months`) in the Player's basket, creating the Account first when the wallet has none. This is the one call the beginner packs
 * make. The relayer cannot pay for it: the Source, its book and the Position are the Player's own rent, so the wallet needs a little SOL
 * (the test cluster tops it up). `minGemas` is the Gemas the pack shows: the program refuses the Advance rather than issue fewer. Throws the plain-language error of the failed step.
 */
export async function openAndAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  deposit: OpenDeposit,
  months: number,
  minGemas: bigint,
  onStep: (s: string) => void = () => undefined,
  token?: StakeToken,
): Promise<OpenedAdvance> {
  if (deposit.from === "simsol") return openPositionWithAdvance(signer, getToken, deposit.baseUnits, months, minGemas, onStep);
  return openStakePositionWithAdvance(signer, getToken, deposit, months, minGemas, token, onStep);
}
