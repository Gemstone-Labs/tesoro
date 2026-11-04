import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_SIZE } from "./account-sizes";

describe("CURRENT_SIZE", () => {
  // A wrong MatchState length makes every Match list come back empty (or full of undecodable old records).
  it("matchState is the program's MatchState::SPACE", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../../programs/tesoro_core/src/state.rs", import.meta.url)), "utf8");
    const num = (re: RegExp) => Number(re.exec(src)?.[1]);
    const record = num(/impl MatchState \{[^}]*?RECORD_LEN: usize = (\d+);/s);
    const holds = num(/pub const ROOM_HOLDS: usize = (\d+);/);
    const holdLen = /impl RoomHold \{\s*pub const LEN: usize = 32 \+ (\d+);/.exec(src);
    expect(src).toMatch(/pub const SPACE: usize =\s*8 \+ 1 \+ Self::RECORD_LEN \+ 1 \+ 4 \+ 32 \+ 64 \+ ROOM_HOLDS \* RoomHold::LEN;/);
    expect(CURRENT_SIZE.matchState).toBe(8 + 1 + record + 1 + 4 + 32 + 64 + holds * (32 + Number(holdLen?.[1])));
  });
});
