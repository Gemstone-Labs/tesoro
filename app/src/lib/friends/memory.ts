/**
 * What the Friends page remembers between visits, so it never starts from nothing:
 * the Friend link (kept in memory for the page load, refreshed only by Reset link) and
 * the shape of the list (kept in this browser, so the loading skeleton matches the real cards).
 */
const links = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();

export const rememberedLink = (me: string): string | null => links.get(me) ?? null;

/** The Friend link: asks `fetchCode` once per page load and Account; later calls answer from memory. */
export function loadLink(me: string, fetchCode: () => Promise<string | null>): Promise<string | null> {
  const known = links.get(me);
  if (known) return Promise.resolve(known);
  const pending =
    loading.get(me) ??
    fetchCode()
      .then((code) => {
        if (code) links.set(me, code);
        return code;
      })
      .finally(() => loading.delete(me));
  loading.set(me, pending);
  return pending;
}

/** Reset link: asks for a new code and keeps it in place of the old one. */
export async function replaceLink(me: string, fetchCode: () => Promise<string | null>): Promise<string | null> {
  const code = await fetchCode();
  if (code) links.set(me, code);
  return code;
}

/** Tests only. */
export const forgetLinks = () => {
  links.clear();
  loading.clear();
};

const shapeKey = (me: string) => `tesoro.friends.shape.${me}`;

/** For each Friend: whether their card showed recent-Match chips. */
export type FriendsShape = Record<string, boolean>;

export function readShape(me: string | null): FriendsShape {
  if (!me) return {};
  try {
    const v = JSON.parse(localStorage.getItem(shapeKey(me)) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as FriendsShape) : {};
  } catch {
    return {};
  }
}

/** Saves the shape; with `accounts`, drops Friends that are gone and adds new ones without chips. */
export function writeShape(me: string, patch: FriendsShape, accounts?: string[]) {
  try {
    const next: FriendsShape = accounts ? Object.fromEntries(accounts.map((a) => [a, patch[a] ?? readShape(me)[a] ?? false])) : { ...readShape(me), ...patch };
    localStorage.setItem(shapeKey(me), JSON.stringify(next));
  } catch {
    /* private window or blocked storage: the skeleton falls back to one plain card */
  }
}
