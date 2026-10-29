import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SimpleVault } from "./SimpleVault";

vi.mock("@/lib/account", () => ({
  useAccount: () => ({ auth: { signer: null, getAccessToken: async () => null }, snapshot: {}, gemas: { available: 0, total: 0 }, loading: false, ready: true, error: null, refresh: async () => {} }),
}));
vi.mock("@/lib/deposit/vault", () => ({ vaultView: () => ({ gemas: 0, deposits: [], otherChainDeposits: false, isNew: false }) }));

describe("Simple Vault deposits", () => {
  it("says there are no deposits without counting earlier withdrawn ones", () => {
    const html = renderToStaticMarkup(<SimpleVault />);
    expect(html).toContain("No deposits right now.");
    expect(html).not.toMatch(/earlier/i);
  });
});
