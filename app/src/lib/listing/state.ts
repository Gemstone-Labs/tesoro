/** Where a Studio’s Game stands, from the paperwork (database) and the chain. Pure: the admin page and the catalogue share it. */
export type ListingStage =
  | "applied" // waiting for an admin
  | "rejected"
  | "awaiting-payment" // accepted, no paid year yet
  | "awaiting-listing" // paid, the admin has not written the listing on chain
  | "listed"
  | "needs-refresh" // the deploy slot moved but the build is the same: anyone can call refresh_listing
  | "needs-reapproval" // the program was upgraded: the admin must approve the new build
  | "expired"; // listed_until passed, or the paid year ended

export interface PaperState {
  status: "applied" | "accepted" | "rejected";
  /** Epoch seconds the paid year ends, or null before the first payment. */
  paidUntil: number | null;
}

export interface ChainListing {
  /** GameRecord.listed_until (epoch seconds; 0 = never listed). */
  listedUntil: number;
  approvedSlot: bigint;
  /** Hex SHA-256 of the approved build, or null when never approved. */
  approvedHash: string | null;
}

export interface LiveProgram {
  /** ProgramData deploy slot now. */
  slot: bigint;
  /** Hex hash of the deployed build now (see `codeHash`). */
  hash: string;
}

export function listingStage(paper: PaperState, chain: ChainListing | null, live: LiveProgram | null, now: number): ListingStage {
  if (paper.status === "applied") return "applied";
  if (paper.status === "rejected") return "rejected";
  if (paper.paidUntil === null) return "awaiting-payment";
  const approved = chain && chain.listedUntil > 0 && chain.approvedHash !== null;
  if (!approved) return paper.paidUntil > now ? "awaiting-listing" : "expired";
  if (chain.listedUntil <= now || paper.paidUntil <= now) return "expired";
  if (!live) return "listed";
  if (live.hash !== chain.approvedHash) return "needs-reapproval";
  if (live.slot !== chain.approvedSlot) return "needs-refresh";
  return "listed";
}

/** The `listed_until` to write when the admin lists: the end of the paid year, never later (on-chain listing must not outlive payment). */
export const listUntilFor = (paidUntil: number): number => paidUntil;

/** Plain words for each stage (DESIGN.md): shown on the admin page and to the Studio. */
export const STAGE_LABEL: Record<ListingStage, string> = {
  applied: "Waiting for review",
  rejected: "Not accepted",
  "awaiting-payment": "Accepted · waiting for the yearly payment",
  "awaiting-listing": "Paid · ready to list",
  listed: "Listed",
  "needs-refresh": "Unlisted until refreshed (code unchanged)",
  "needs-reapproval": "Unlisted · new version needs approval",
  expired: "Listing ended",
};

export const isFeaturedNow = (featured: boolean, stage: ListingStage) => featured && stage === "listed";
