import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PositionTile } from "@/app/wallet/PositionTile";
import { MatchResult } from "@/components/match/MatchResult";

const LABEL = "Simulated yield · 1 month = 10 min";

describe("simulated-yield label", () => {
  it("is on every Position tile, on-chain or not", () => {
    const html = renderToStaticMarkup(
      <PositionTile chain="SOL" label="SOL Position" status="active" rows={{ principal: "40 SOL", debt: "0.55 SOL", apy: "7%", unlock: "—" }} chartTitle="Debt" series={null} />,
    );
    expect(html).toContain(LABEL);
  });

  it("is next to a won Match's pending Gemas", () => {
    const html = renderToStaticMarkup(
      <MatchResult game="block-puzzle" outcome="won" delta={900} entry={1000} fee={100} role="player" backed={false} scores={["171", "55"]} playAgainHref="/play/block-puzzle" />,
    );
    expect(html).toContain("Pending · redeemable");
    expect(html).toContain(LABEL);
  });
});
