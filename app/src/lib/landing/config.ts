export type LaunchStage = "testnet" | "mainnet";

/** Testnet-only content (Status band, chain status, footer line) renders only on testnet. */
export const LAUNCH_STAGE: LaunchStage = process.env.NEXT_PUBLIC_LAUNCH_STAGE === "mainnet" ? "mainnet" : "testnet";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

/** A link into the app, which lives on its own URL at launch (`NEXT_PUBLIC_APP_URL`). */
export const appHref = (path = "/lobby") => `${APP_URL}${path}`;

/** Outbound links; unset ones render as dimmed placeholders (the GitHub org and the X account don't exist yet). */
export const OUTBOUND = {
  docs: process.env.NEXT_PUBLIC_DOCS_URL ?? "/docs",
  x: process.env.NEXT_PUBLIC_X_URL,
  github: process.env.NEXT_PUBLIC_GITHUB_URL,
};
