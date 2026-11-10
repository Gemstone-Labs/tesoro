import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Full runs share a busy build server: a first import or an in-process Postgres start can take several seconds there.
  test: { testTimeout: 20_000, hookTimeout: 60_000 },
});
