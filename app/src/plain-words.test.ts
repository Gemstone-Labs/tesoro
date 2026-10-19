import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Players read plain money words (CONTEXT.md, founder 2026-10-19); code and on-chain names keep the old ones.
 * This test reads every source file and fails when text a Player can see uses an old word.
 */
const OLD_WORDS: [RegExp, string][] = [
  [/\bOpen (a|an|your) Position\b/, "Get Gemas"],
  [/\bPositions?\b/, "Lock / Locks"],
  [/\bPrincipal\b/, "Locked amount, or \"your SOL\" / \"what you lock\""],
  [/\bDebt\b/, "Left to pay back (\"Paid back\" at zero)"],
  [/\bHorizon\b/, "Length"],
  [/\bAccrued Yield\b/i, "Earned"],
  [/\bsimSOL\b/, "test SOL"],
];

/** Text that keeps an old word on purpose, as `path: substring of the text`. Say why. */
const ALLOW: { file: string; text: string; why: string }[] = [
  { file: "components/match/MatchSpectate.tsx", text: "Positions", why: "Trading Duel trade positions, not a Lock" },
];

const ROOT = join(__dirname);
const SKIP_DIRS = ["lib/chain/idl"];
/** Developer docs name on-chain accounts in code font: "a Lock (the `Position` account)". */
const CODE_DOCS = "app/(docs)/docs/developers/";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.includes(relative(ROOT, p)) ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec|stories)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

/** Strings that are code, not copy: imports, object keys, type positions, logs and lookups by name. */
function isCode(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n) || ts.isLiteralTypeNode(n)) return true;
    if (ts.isPropertyAssignment(n) && n.name === node) return true;
    if (ts.isElementAccessExpression(n) && n.argumentExpression === node) return true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      if (/^(console\.\w+|log\.\w+|logger\.\w+|require|s|Buffer\.from|new TextEncoder\(\)\.encode)$/.test(callee)) return true;
    }
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "code") return true;
    if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function playerText(path: string): { text: string; line: number }[] {
  const src = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { text: string; line: number }[] = [];
  const add = (node: ts.Node, text: string) => {
    if (text.trim() && !isCode(node)) out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" … "));
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("plain money words", () => {
  it("no Player-facing text uses an old word", () => {
    const hits: string[] = [];
    for (const path of files(ROOT)) {
      const rel = relative(ROOT, path);
      if (rel.startsWith(CODE_DOCS)) continue;
      for (const { text, line } of playerText(path)) {
        for (const [re, use] of OLD_WORDS) {
          if (!re.test(text)) continue;
          if (ALLOW.some((a) => a.file === rel && text.includes(a.text))) continue;
          hits.push(`${rel}:${line}  "${text.trim().slice(0, 90)}"  → use ${use}`);
        }
      }
    }
    expect(
      hits,
      "Player-facing text uses an old money word (see CONTEXT.md: Players read Lock, Locked amount, Left to pay back, Length, Earned, test SOL). " +
        "Reword it; if the string is code a Player never sees, add it to ALLOW in src/plain-words.test.ts with a reason.",
    ).toEqual([]);
  });
});
