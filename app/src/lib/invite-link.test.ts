import { describe, expect, it } from "vitest";
import { inviteFromSearch } from "./invite-link";

describe("inviteFromSearch", () => {
  it("reads the code", () => expect(inviteFromSearch("?invite=ABCD-EFGH-JKMN-PQRS")).toBe("ABCD-EFGH-JKMN-PQRS"));
  it("is empty without one", () => expect(inviteFromSearch("?x=1")).toBe(""));
  it("ignores junk", () => expect(inviteFromSearch("?invite=<script>")).toBe(""));
});
