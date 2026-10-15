/** The code in an Invite email link (`?invite=XXXX-XXXX-XXXX-XXXX`), or "" when there is none. */
export function inviteFromSearch(search: string): string {
  const raw = new URLSearchParams(search).get("invite") ?? "";
  return /^[0-9A-Za-z -]{1,40}$/.test(raw) ? raw.trim() : "";
}
