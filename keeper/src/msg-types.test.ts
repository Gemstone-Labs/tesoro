// The keeper's LayerZero message type numbers must be the ones the bridge program decodes (msg_codec.rs), and every
// send must quote the type of the message it sends.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MSG_TYPE as APP_MSG_TYPE } from "../../app/src/server/bridge-send.ts";
import { MSG } from "./msg-types.ts";

const rust = readFileSync(new URL("../../bridge/programs/tesoro_bridge/src/msg_codec.rs", import.meta.url), "utf8");
const rustTypes = Object.fromEntries([...rust.matchAll(/pub const MSG_([A-Z_]+): u8 = (\d+);/g)].map((m) => [m[1], Number(m[2])]));

describe("message types", () => {
  it("MSG holds every type of msg_codec.rs under the same name and number", () => {
    assert.deepEqual(MSG, rustTypes);
  });
  it("agree with the app's send kinds", () => {
    assert.deepEqual([APP_MSG_TYPE.unlock, APP_MSG_TYPE.yield, APP_MSG_TYPE.instant, APP_MSG_TYPE.prize], [MSG.UNLOCK, MSG.PAY_YIELD, MSG.PAY_INSTANT, MSG.PAY_PRIZE]);
  });
});
