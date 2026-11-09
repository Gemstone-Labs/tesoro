import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newPractice, practiceBrake, practiceJump, practiceView, simRiders, PRACTICE_ME } from "./session";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = join(SRC, "games/railcar/practice/RailcarPractice.tsx");

/** Every source file the module loads when it runs: static value imports, followed through `@/` and relative paths. */
function loads(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    const code = readFileSync(file, "utf8");
    const deps: string[] = [];
    seen.set(file, deps);
    // `import x from`, `import { a } from`, `export { a } from`, `import "./side-effect"`; never `import type` / `export type`.
    for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      const spec = m[1];
      const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) {
        deps.push(spec);
        continue;
      }
      const hit = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((x) => base + x).find((p) => existsSync(p) && !p.endsWith(".css") && /\.tsx?$/.test(p));
      if (hit) {
        deps.push(relative(SRC, hit));
        walk(hit);
      }
    }
  };
  walk(entry);
  return seen;
}

/** What only the chain path needs: a wallet, the sponsor, an RPC or rollup connection, a signature. */
const CHAIN_ONLY = [
  /@privy-io\//,
  /^lib\/account/,
  /sponsor/i,
  /^lib\/chain\/(client|rpc-config|rpc-fetch|split-connection|sponsor-client|sponsored-or-own|ChainDataProvider|read|signed-request|use[-A-Z][^/]*|[^/]*-client|[^/]*-flow)\.tsx?$/,
  /^games\/railcar\/(chain|useRailcar|ticker|signers|finish|finish-steps|sweep|step-off|setup|flow|view|fixtures)\.tsx?$/,
  /^@magicblock-labs\//,
  /^@coral-xyz\//,
];
const CHAIN_CALLS = /new Connection\(|sendTransaction|signTransaction|sendRawTransaction|getLatestBlockhash|useWallets|new WebSocket\(/;

describe("Practice never touches the chain", () => {
  const graph = loads(ENTRY);

  it("loads no wallet, sponsor or RPC module", () => {
    const bad = [...graph.entries()].flatMap(([file, deps]) => deps.filter((d) => CHAIN_ONLY.some((r) => r.test(d))).map((d) => `${relative(SRC, file)} -> ${d}`));
    expect(bad).toEqual([]);
  });

  it("no module it loads opens a connection or signs", () => {
    const calls = [...graph.keys()].filter((f) => CHAIN_CALLS.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(calls).toEqual([]);
  });

  it("the check sees the chain path when it is there (the real Railcar route)", () => {
    const real = loads(join(SRC, "app/(app)/play/railcar/RailcarRoute.tsx"));
    expect([...real.values()].flat().some((d) => CHAIN_ONLY.some((r) => r.test(d)))).toBe(true);
  });
});

describe("a Practice ride makes no network call", () => {
  const fetch = vi.fn(() => Promise.reject(new Error("Practice must not fetch")));
  const ws = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", ws);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetch.mockClear();
    ws.mockClear();
  });

  it("from the first second to the Result, with a Brake and a Jump", () => {
    const draw = crypto.getRandomValues(new Uint8Array(32));
    let p = newPractice(draw);
    for (let t = 0; t < 700_000; t += 100) {
      if (t === 3_000) p = practiceBrake(p, t);
      if (t === 20_000) p = practiceJump(p, t);
      if (practiceView(p, t).phase === "result") break;
    }
    expect(practiceView(p, 700_000).phase).toBe("result");
    expect(fetch).not.toHaveBeenCalled();
    expect(ws).not.toHaveBeenCalled();
  });

  it("the names on screen never ask the chain or the name service who a rider is", async () => {
    const { requestIdentity } = await import("@/lib/identity/store");
    for (const id of [PRACTICE_ME, ...simRiders(new Uint8Array(32)).map((r) => r.id)]) requestIdentity(id);
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();
  });
});
