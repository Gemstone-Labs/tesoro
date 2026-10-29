import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

describe("every Buy Gemas entry point opens the one sheet", () => {
  it.each([
    "components/shell/TopBar.tsx",
    "app/(app)/vault/VaultHeader.tsx",
    "app/(app)/vault/page.tsx",
    "components/deposit/GetGemasButton.tsx",
  ])("%s asks the deposit bus", (file) => {
    expect(src(file)).toContain("requestDeposit");
  });

  it("no other Buy Gemas sheet or bus exists", () => {
    expect(() => readFileSync(join(__dirname, "../../lib/get-gemas.ts"))).toThrow();
    expect(src("app/(app)/wallet/WalletView.tsx")).not.toContain("<Sheet");
    expect(src("components/deposit/DepositSheet.tsx")).not.toContain("router.push");
  });
});
