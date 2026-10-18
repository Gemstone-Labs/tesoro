import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { POSITION_SPACE, isCurrentPosition } from "./position-size";

describe("POSITION_SPACE", () => {
  it("is the byte length of a PositionState in the IDL", () => {
    const coder = new BorshAccountsCoder(coreIdl as Idl);
    expect(coder.size("PositionState" as never)).toBe(POSITION_SPACE);
  });

  it("keeps only accounts of the current length (a pre-upgrade Position is 159 bytes)", () => {
    expect(isCurrentPosition(Buffer.alloc(POSITION_SPACE))).toBe(true);
    expect(isCurrentPosition(Buffer.alloc(159))).toBe(false);
  });
});
