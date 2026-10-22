import type { ChainMatch } from "@/lib/chain/read";
import type { ScreenData } from "./screen";

/** Where a step runs. */
export type Layer = "app" | "wallet" | "server" | "solana" | "er" | "tee" | "vrf" | "oracle";

export const LAYERS: Record<Layer, string> = {
  app: "App",
  wallet: "Wallet signs",
  server: "Tesoro server",
  solana: "Solana",
  er: "Ephemeral Rollup",
  tee: "Private rollup (TEE)",
  vrf: "VRF",
  oracle: "Price oracle",
};

/** One step of a Match flow: what the page shows and what the chain mocks answer while it is current. */
export interface Frame {
  label: string;
  /** The address bar at this step. */
  url: string;
  /** `enter`: the Queue / Challenge page. `match`: `/play/match/<id>` through MatchRoute. */
  show: "enter" | "match";
  /** The progress line the entry reports (`onStep`). */
  status?: string;
  /** The entry has landed: the page moves on to the Match. */
  entered?: "joined" | "opened" | "existing";
  /** MatchRoute's read of the Match has answered. */
  routed?: boolean;
  /** What `fetchMatch` returns. */
  match?: ChainMatch | null;
  /** What the Match drivers report. */
  screen?: ScreenData;
  layers: Layer[];
  /** What happens underneath, in developer terms. */
  what: string;
  /** Instructions and calls this step sends. */
  calls?: string[];
  /** How long autoplay stays on this step. */
  ms?: number;
  /** Mount the page afresh (the real page would get here by polling, or after a run the story can't play). */
  remount?: boolean;
  /** Press the button with this text on arrival. */
  click?: string;
}

let frame: Frame | null = null;
const listeners = new Set<() => void>();

export const flowFrame = () => frame;

export function setFlowFrame(f: Frame | null) {
  frame = f;
  for (const l of [...listeners]) l();
}

/** Drops every pending wait, when a flow story unmounts. */
export function resetFlow() {
  listeners.clear();
  frame = null;
}

/** Runs `check` on the current frame and every later one; resolves once it returns true. */
export function untilFrame(check: (f: Frame) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const run = () => {
      if (frame && check(frame)) {
        listeners.delete(run);
        resolve();
      }
    };
    listeners.add(run);
    run();
  });
}
