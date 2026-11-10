import { it } from "vitest";
it("prof", async () => {
  { const t = Date.now(); await import("@solana/web3.js"); console.log("T", "@solana/web3.js", Date.now() - t); }
  { const t = Date.now(); await import("react"); console.log("T", "react", Date.now() - t); }
  { const t = Date.now(); await import("@/games/block-puzzle/chain"); console.log("T", "@/games/block-puzzle/chain", Date.now() - t); }
  { const t = Date.now(); await import("@/lib/chain/basket"); console.log("T", "@/lib/chain/basket", Date.now() - t); }
  { const t = Date.now(); await import("@/lib/chain/match-id"); console.log("T", "@/lib/chain/match-id", Date.now() - t); }
  { const t = Date.now(); await import("@/lib/chain/many-seat"); console.log("T", "@/lib/chain/many-seat", Date.now() - t); }
  { const t = Date.now(); await import("@/lib/chain/many-seat-plan"); console.log("T", "@/lib/chain/many-seat-plan", Date.now() - t); }
  { const t = Date.now(); await import("@/lib/storage"); console.log("T", "@/lib/storage", Date.now() - t); }
  { const t = Date.now(); await import("./chain"); console.log("T", "./chain", Date.now() - t); }
  { const t = Date.now(); await import("./brake"); console.log("T", "./brake", Date.now() - t); }
  { const t = Date.now(); await import("./boarding"); console.log("T", "./boarding", Date.now() - t); }
  { const t = Date.now(); await import("./step-off"); console.log("T", "./step-off", Date.now() - t); }
  { const t = Date.now(); await import("./step-off-send"); console.log("T", "./step-off-send", Date.now() - t); }
  { const t = Date.now(); await import("./finish"); console.log("T", "./finish", Date.now() - t); }
  { const t = Date.now(); await import("./flow"); console.log("T", "./flow", Date.now() - t); }
  { const t = Date.now(); await import("./signers"); console.log("T", "./signers", Date.now() - t); }
  { const t = Date.now(); await import("./tells"); console.log("T", "./tells", Date.now() - t); }
  { const t = Date.now(); await import("./payout"); console.log("T", "./payout", Date.now() - t); }
  { const t = Date.now(); await import("@/games/block-puzzle/table-feed"); console.log("T", "@/games/block-puzzle/table-feed", Date.now() - t); }
  { const t = Date.now(); await import("./pace"); console.log("T", "./pace", Date.now() - t); }
  { const t = Date.now(); await import("./ticker"); console.log("T", "./ticker", Date.now() - t); }
  { const t = Date.now(); await import("./step-retry"); console.log("T", "./step-retry", Date.now() - t); }
  { const t = Date.now(); await import("./view"); console.log("T", "./view", Date.now() - t); }
  { const t = Date.now(); await import("./RailcarScreen"); console.log("T", "./RailcarScreen", Date.now() - t); }
}, 60000);
