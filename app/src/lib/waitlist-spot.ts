import { BRAND } from "./brand";
import { parseRoles, type Role } from "./waitlist-role";

/**
 * A waitlist spot and the gemstone animal in its pack. Spots deal the twelve player avatars in a fixed
 * order (step 5 visits all twelve before repeating), so friends who join together get different gems.
 */
export const GEMS = [
  { stone: "Ruby", animal: "Jaguar", hex: "#E0283C" },
  { stone: "Sapphire", animal: "Macaw", hex: "#2F5BEA" },
  { stone: "Amber", animal: "Toucan", hex: "#F08A1C" },
  { stone: "Smoky Quartz", animal: "Capybara", hex: "#A9744A" },
  { stone: "Rose Quartz", animal: "Axolotl", hex: "#F2A6C0" },
  { stone: "Aquamarine", animal: "Hummingbird", hex: "#9CC8F2" },
  { stone: "Amethyst", animal: "Owl", hex: "#9A5CF0" },
  { stone: "Onyx", animal: "Caiman", hex: "#8A94A6" },
  { stone: "Citrine", animal: "Tamarin", hex: "#F2C81C" },
  { stone: "Quartz", animal: "Llama", hex: "#E6E8EE" },
  { stone: "Garnet", animal: "Maned Wolf", hex: "#D1245A" },
  { stone: "Hematite", animal: "Armadillo", hex: "#9AA1AC" },
] as const;

export const MAX_SPOT = 999_999;

export type SpotGem = { spot: number; avatar: number; name: string; hex: string };

/** `avatar` is 1-based, matching `art.avatars` file names. */
export function gemFor(spot: number): SpotGem {
  const i = ((spot - 1) * 5) % GEMS.length;
  const g = GEMS[i];
  return { spot, avatar: i + 1, name: `${g.stone} ${g.animal}`, hex: g.hex };
}

/** A spot from a URL segment, or null when it is not a whole number in range. */
export function parseSpot(raw: string): number | null {
  if (!/^[1-9]\d{0,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_SPOT ? n : null;
}

/** A shared spot link; the member's roles ride along so the X card can print them: /spot/142-player-staker. */
export const spotPath = (spot: number, roles: readonly Role[] = []) => `/spot/${[spot, ...roles].join("-")}`;

/** The spot and roles in a shared link's segment, or null when any part is unknown or repeated. */
export function parseSpotSlug(raw: string): { spot: number; roles: Role[] } | null {
  const [head, ...rest] = raw.split("-");
  const spot = parseSpot(head);
  if (!spot) return null;
  const roles = parseRoles(rest.join(","));
  return roles.length === rest.length ? { spot, roles } : null;
}

/** The X post: the link sits in the text, on its own line, because X's url field glues it to the last word. */
export function shareText(gem: SpotGem, url: string): string {
  return `I'm #${gem.spot} on the ${BRAND.handle} waitlist and pulled the ${gem.name}! What's yours?

Open your pack: ${url}`;
}
