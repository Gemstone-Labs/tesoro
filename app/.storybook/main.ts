import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { StorybookConfig } from "@storybook/nextjs-vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const MOCKS = path.join(HERE, "mocks");
const EXTS = [".ts", ".tsx"];
/** Packages are not mirrored by path: Privy's email login is swapped by name. */
const PRIVY_MOCK = path.join(MOCKS, "email-login.ts");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : EXTS.includes(path.extname(p)) ? [p] : [];
  });
}

/**
 * Swaps an app module for its mock: `.storybook/mocks/src/lib/x.ts` replaces `src/lib/x.ts` for every
 * importer except the mock itself, which can import the real module by its own path.
 */
export function mirrorMocks(): Plugin {
  const byTarget = new Map<string, string>();
  for (const mock of walk(MOCKS)) {
    const rel = path.relative(MOCKS, mock).replace(/\.(ts|tsx)$/, "");
    const real = EXTS.map((x) => path.join(APP, rel + x)).find(existsSync);
    if (real) byTarget.set(real, mock);
  }
  return {
    name: "tesoro-mirror-mocks",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith("\0")) return null;
      if (source === "@privy-io/react-auth") return PRIVY_MOCK;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const mock = byTarget.get(resolved.id.split("?")[0]);
      if (!mock || importer.split("?")[0] === mock) return null;
      return mock;
    },
  };
}

const config: StorybookConfig = {
  framework: { name: "@storybook/nextjs-vite", options: {} },
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs"],
  staticDirs: ["../public", { from: "../assets/share", to: "/share-assets" }],
  core: { disableTelemetry: true },
  async viteFinal(cfg) {
    cfg.plugins = [...(cfg.plugins ?? []), mirrorMocks(), nodePolyfills({ include: ["buffer", "process", "crypto", "stream", "util"], globals: { Buffer: true, process: true } })];
    // Loaded only by the landing's motion, so Vite would otherwise discover them late and reload mid-story.
    cfg.optimizeDeps = { ...cfg.optimizeDeps, include: [...(cfg.optimizeDeps?.include ?? []), "gsap", "gsap/ScrollTrigger", "lenis"] };
    return cfg;
  },
};

export default config;