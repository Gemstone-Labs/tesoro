// The keeper's LayerZero message type numbers must be the ones the bridge program decodes (msg_codec.rs), and every
// send must quote the type of the message it sends.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MSG } from "./msg-types.ts";

const rust = readFileSync(new URL("../../bridge/programs/tesoro_bridge/src/msg_codec.rs", import.meta.url), "utf8");
const rustTypes = Object.fromEntries([...rust.matchAll(/pub const MSG_([A-Z_]+): u8 = (\d+);/g)].map((m) => [m[1], Number(m[2])]));

describe("message types", () => {
  it("MSG holds every type of msg_codec.rs under the same name and number", () => {
    assert.deepEqual(MSG, rustTypes);
  });
  it("agree with the app's send kinds", () => {
    const src = readFileSync(new URL("../../app/src/server/bridge-send.ts", import.meta.url), "utf8");
    const app = /MSG_TYPE = \{ unlock: (\d+), yield: (\d+), instant: (\d+), prize: (\d+) \}/.exec(src)!.slice(1).map(Number);
    assert.deepEqual(app, [MSG.UNLOCK, MSG.PAY_YIELD, MSG.PAY_INSTANT, MSG.PAY_PRIZE]);
  });
});
