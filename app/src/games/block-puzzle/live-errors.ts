import idl from "../../lib/chain/idl/block_puzzle.json";

const NAMES = new Map<number, string>((idl.errors as { code: number; name: string }[]).map((e) => [e.code, e.name]));

/**
 * The program error a failed transaction carried: from the log line (`Error Code: Frozen`), or from the custom code of the
 * instruction error (`{"InstructionError":[0,{"Custom":6015}]}`, which is all the rollup may show). `null` for anything else
 * (a dropped connection, a timeout).
 */
export function burstErrorName(e: unknown): string | null {
  const text = e instanceof Error ? e.message : String(e);
  const named = /Error Code: (\w+)/.exec(text);
  if (named) return named[1];
  const code = /"?Custom"?\W+(\d{4})/.exec(text);
  return code ? (NAMES.get(Number(code[1])) ?? null) : null;
}
