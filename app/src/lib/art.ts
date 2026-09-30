/**
 * Every piece of game art and avatar the UI shows, in one map. Final art comes from Astra
 * (~/Work/gemstone-labs/tesoro/art-source/ui-redesign/assets/, outside the repo), imported as WebP
 * into `public/art/final/` by `app/scripts/import-final-art.mjs`.
 */
const f = (name: string) => `/art/final/${name}.webp`;

const c = (name: string) => `/art/final/characters/${name}.webp`;

export const art = {
  /** Wide hero art (2400x1000), left 40% dark and empty for the title. */
  blockPuzzleHero: f("block-puzzle-hero"),
  holdemHero: f("holdem-hero"),
  /** Square key art. */
  blockPuzzleTile: f("block-puzzle-tile"),
  holdemTile: f("holdem-tile"),
  comingSoon: {
    "word-duel": f("coming-soon-word-duel"),
    "bubble-burst": f("coming-soon-bubble-burst"),
    "pocket-pool": f("coming-soon-pocket-pool"),
    "trivia-sprint": f("coming-soon-trivia-sprint"),
  },
  /** Play Again thumbs reuse the square tiles (cropped by CSS). */
  thumb: {
    "block-puzzle": f("block-puzzle-tile"),
    holdem: f("holdem-tile"),
  },
  /**
   * Guide characters. him = the Player / guide; her = the Backer. Full-body, transparent, 640x640
   * (duo 1200x600). Placement rules are in DESIGN.md.
   */
  characters: {
    himWelcome: c("him-welcome"),
    himExplain: c("him-explain"),
    himWin: c("him-win"),
    himLose: c("him-lose"),
    himWaiting: c("him-waiting"),
    herBacking: c("her-backing"),
    herEmpty: c("her-empty"),
    herWaitingCrosschain: c("her-waiting-crosschain"),
    duoHero: c("duo-hero"),
    duoWin: c("duo-win"),
  },
  /** Demo/seed avatars. */
  avatars: [1, 2, 3, 4, 5, 6].map((n) => f(`avatar-${n}`)),
} as const;
/** A stable avatar for a Player key, so the same Player always shows the same face. */
export function avatarFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return art.avatars[h % art.avatars.length];
}
