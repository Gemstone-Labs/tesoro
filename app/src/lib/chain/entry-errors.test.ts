import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASKET, CORE, MATCH, entryError } from "./entry-errors";

describe("entryError", () => {
  it("reads the error name from the program log", () => {
    expect(entryError(new Error("base tx failed abc\nProgram log: AnchorError ... Error Code: OnBreak. Error Number: 6154."))).toMatch(/Break/);
  });
  it("reads CoreError, Match and basket numbers", () => {
    expect(entryError(new Error('failed {"InstructionError":[0,{"Custom":6150}]}'))).toMatch(/Entry Limit/);
    expect(entryError(new Error("custom program error: 0x180a"))).toMatch(/Break/);
    expect(entryError(new Error('{"Custom":6406}'))).toMatch(/Faster Gemas|prepared|many Gemas|room/i);
    expect(entryError(new Error('{"Custom":6303}'))).toMatch(/Free transactions/);
    expect(entryError(new Error('{"Custom":6184}'))).toMatch(/room/);
  });
  it("falls back to the shared sentence for anything else", () => {
    expect(entryError(new Error("blockhash not found"))).toMatch(/busy/);
  });
});

describe("error tables", () => {
  // tesoro_core numbers its errors by position, so a name added, removed or renamed in Rust shifts every code after it.
  const rust = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../programs/tesoro_core/src/${file}`, import.meta.url)), "utf8");
  const variants = (src: string, start: string) => {
    const body = src.slice(src.indexOf(start) + start.length);
    return [...body.slice(0, body.indexOf("\n}")).matchAll(/^\s{4}(\w+)(?: =>|,)/gm)].map((m) => m[1]);
  };
  it("match the program's CoreError, BasketError and MatchError, in order", () => {
    expect(CORE).toEqual(variants(rust("ledger/mod.rs"), "core_errors! {"));
    expect(BASKET).toEqual(variants(rust("error.rs"), "pub enum BasketError {"));
    expect(MATCH).toEqual(variants(rust("error.rs"), "pub enum MatchError {"));
  });
});
