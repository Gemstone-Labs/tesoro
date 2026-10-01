import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "./status";

const record = readFileSync(resolve(__dirname, "../../../../docs/deployments.md"), "utf8");

describe("Status band", () => {
  it.each(DEPLOYMENTS.flatMap((g) => g.items))("$name is in docs/deployments.md", ({ address }) => {
    expect(record).toContain(address);
  });
});
