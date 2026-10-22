import { PublicKey } from "@solana/web3.js";
import type { BackingBoard } from "@/lib/chain/backing";
import type { PlayerAccount } from "@/lib/chain/player-account";
import type { AccountSnapshot } from "@/lib/chain/read";
import type { SettledMatch } from "@/lib/chain/recent";

/** Who is looking at the story: the toolbar "Auth" switch, or `parameters.auth` on a story. */
export type AuthMode = "signed-in" | "signed-out" | "loading";

/**
 * What the mocked chain reads return for the current story. Set per story with `parameters.data`;
 * anything left out falls back to the demo fixtures in `src/lib/chain/fixture.ts`.
 */
export interface StoryData {
  /** The signed-in Account's snapshot; `null` = still loading. Default: `demoSnapshot(DEMO_ME)`. */
  snapshot?: AccountSnapshot | null | ((address: string) => AccountSnapshot | null);
  /** Error shown instead of a snapshot (the "Couldn't load your Account" state). */
  snapshotError?: string;
  /** The Backing board, or a function of the demo board (read when the story renders, so another story's board never leaks in). */
  board?: BackingBoard | ((demo: BackingBoard) => BackingBoard);
  settled?: SettledMatch[];
  playerAccount?: (address: string) => PlayerAccount;
}

/** The demo Account's key: Matches in the fixtures are played from it, so its Account page is "your own". */
export const DEMO_ME = PublicKey.findProgramAddressSync([Buffer.from("demo-1")], PublicKey.default)[0].toBase58();
export const DEMO_EVM = "0x4Ce2a8b91F0d3E57c1A6d9f2B08E7a3d51c6F9a2";

interface Current {
  data: StoryData;
  auth: AuthMode;
  /** Toolbar "Guide": show the character's tips (they always reappear, dismissals are forgotten). */
  guide: boolean;
}

let current: Current = { data: {}, auth: "signed-in", guide: false };

/** Set by the global decorator before the story renders; read by the module mocks. */
export function setStoryData(next: Current) {
  current = next;
}

export function storyData() {
  return current;
}
