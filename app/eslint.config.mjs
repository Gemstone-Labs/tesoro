import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Anchor accounts decoded from the IDL JSON are untyped at compile time.
    files: ["src/lib/chain/**", "src/server/**", "src/games/block-puzzle/chain.ts", "src/games/block-puzzle/live-chain.ts", "src/games/holdem/chain.ts", "src/games/holdem/useHoldemMatch.ts", "src/games/trading-duel/chain.ts", "src/games/trading-duel/useDuelMatch.ts", "src/games/vanguard/chain.ts", "src/games/vanguard/useVanguardMatch.ts", "src/components/match/MatchRoute.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
