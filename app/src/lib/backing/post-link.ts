/** The Backing board with the Post a Request sheet open (the Vault's Borrow Gemas). */
export const POST_REQUEST_HREF = "/backing?post=1";

export function wantsPostRequest(search: string): boolean {
  return new URLSearchParams(search).get("post") === "1";
}
