import { describe, expect, it } from "vitest";
import { POST_REQUEST_HREF, wantsPostRequest } from "./post-link";

describe("Post a Request link", () => {
  it("points at the Backing board and asks for the Post a Request sheet", () => {
    expect(POST_REQUEST_HREF).toBe("/backing?post=1");
    expect(wantsPostRequest(POST_REQUEST_HREF.slice("/backing".length))).toBe(true);
  });

  it("is off for any other query", () => {
    expect(wantsPostRequest("")).toBe(false);
    expect(wantsPostRequest("?post=0")).toBe(false);
    expect(wantsPostRequest("?tab=mine")).toBe(false);
  });
});
