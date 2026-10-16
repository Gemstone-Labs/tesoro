import { CLUSTER } from "../cluster-settings";

export type LaunchStage = "testnet" | "mainnet";

/**
 * Testnet-only content (Status band, chain status, footer line) renders only on testnet.
 * Follows the active cluster; NEXT_PUBLIC_LAUNCH_STAGE overrides it (e.g. a mainnet build still pre-launch).
 */
export function launchStageOf(override: string | undefined, cluster: string): LaunchStage {
  if (override === "mainnet" || override === "testnet") return override;
  return cluster === "mainnet" ? "mainnet" : "testnet";
}
export const LAUNCH_STAGE: LaunchStage = launchStageOf(process.env.NEXT_PUBLIC_LAUNCH_STAGE, CLUSTER.id);

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

/** A link into the app, which lives on its own URL at launch (`NEXT_PUBLIC_APP_URL`). */
export const appHref = (path = "/lobby") => `${APP_URL}${path}`;

/** Outbound links; an env value overrides the default, an unset one renders as a dimmed placeholder. */
export const OUTBOUND = {
  docs: process.env.NEXT_PUBLIC_DOCS_URL ?? "/docs",
  x: process.env.NEXT_PUBLIC_X_URL ?? "https://x.com/PlayTesoro",
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/Gemstone-Labs/tesoro",
};
