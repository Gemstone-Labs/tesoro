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
  {
    // Next.js bundles its own `buffer` (v5) for the browser: no readBig*/writeBig* methods. A Position read through one
    // threw in the browser, was caught, and the Vault showed every Gema as Pending. Read and write through a DataView.
    files: ["src/lib/**", "src/games/**", "src/components/**", "src/app/**"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name=/^(read|write)Big/]",
          message: "The browser's Buffer has no BigInt methods. Use a DataView (rdU64/rdI64/u64 in lib/chain/native.ts).",
        },
      ],
    },
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
