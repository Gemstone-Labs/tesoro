import { BRAND } from "./brand";

export interface FriendShareBrowser {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  copy?: (text: string) => Promise<void>;
}

export type FriendShareResult = "shared" | "copied" | "cancelled" | "manual";

/** Share the existing resettable Friend link, without page filters or dev-wallet parameters. */
export function friendShareData(code: string, origin: string) {
  return {
    title: `Add me on ${BRAND.name}`,
    text: `Add me as a friend on ${BRAND.name}.`,
    url: new URL(`/friend/${encodeURIComponent(code)}`, new URL(origin).origin).href,
  };
}

export async function copyFriendLink(url: string, browser: FriendShareBrowser): Promise<"copied" | "manual"> {
  try {
    if (browser.copy) {
      await browser.copy(url);
      return "copied";
    }
  } catch {
    // The caller shows a selectable URL when clipboard access is denied.
  }
  return "manual";
}

/** Invoke native sharing before any await so the browser retains the button's user activation. */
export async function shareFriendLink(data: ReturnType<typeof friendShareData>, browser: FriendShareBrowser): Promise<FriendShareResult> {
  try {
    if (browser.share && (!browser.canShare || browser.canShare(data))) {
      await browser.share(data);
      return "shared";
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "cancelled";
  }
  return copyFriendLink(data.url, browser);
}
