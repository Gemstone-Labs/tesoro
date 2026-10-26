import { describe, expect, it, vi } from "vitest";
import { copyFriendLink, friendShareData, shareFriendLink } from "./friend-share";

const code = "add-me-code";
const data = friendShareData(code, "https://test.playtesoro.com/friends?dev=alice#history");

describe("Friend link sharing", () => {
  it("shares the existing Friend link on the current deployment without page filters or dev parameters", () => {
    expect(data).toEqual({
      title: "Add me on Tesoro",
      text: "Add me as a friend on Tesoro.",
      url: `https://test.playtesoro.com/friend/${code}`,
    });
    expect(friendShareData("a/b?c", "https://www.playtesoro.com").url).toBe("https://www.playtesoro.com/friend/a%2Fb%3Fc");
  });

  it("opens native sharing immediately from the user gesture without copying the clipboard", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn();
    const result = shareFriendLink(data, { share, copy });
    expect(share).toHaveBeenCalledWith(data);
    await expect(result).resolves.toBe("shared");
    expect(copy).not.toHaveBeenCalled();
  });

  it("leaves the clipboard untouched when the user cancels the share sheet", async () => {
    const copy = vi.fn();
    await expect(shareFriendLink(data, {
      share: vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")),
      copy,
    })).resolves.toBe("cancelled");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies the link when native sharing is unavailable", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareFriendLink(data, { copy })).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledExactlyOnceWith(data.url);
  });

  it("copies when the browser cannot share this payload", async () => {
    const share = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareFriendLink(data, { share, canShare: () => false, copy })).resolves.toBe("copied");
    expect(share).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith(data.url);
  });

  it("falls back to copying when browser permissions block native sharing", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareFriendLink(data, {
      share: vi.fn().mockRejectedValue(new DOMException("Blocked", "NotAllowedError")),
      copy,
    })).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith(data.url);
  });

  it("offers a manually copyable link when neither browser capability is available", async () => {
    await expect(shareFriendLink(data, {})).resolves.toBe("manual");
  });

  it("offers manual copying after a denied clipboard write instead of reporting success", async () => {
    await expect(copyFriendLink(data.url, {
      copy: vi.fn().mockRejectedValue(new DOMException("Blocked", "NotAllowedError")),
    })).resolves.toBe("manual");
  });

  it("the explicit Copy link action never opens a share sheet", async () => {
    const share = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(copyFriendLink(data.url, { share, copy })).resolves.toBe("copied");
    expect(share).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledExactlyOnceWith(data.url);
  });
});
