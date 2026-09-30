/**
 * Every piece of game art and avatar the UI shows, in one map. Final art comes from Astra
 * (~/Work/gemstone-labs/tesoro/art-source/ui-redesign/assets/, outside the repo), imported as WebP
 * into `public/art/final/` by `app/scripts/import-final-art.mjs`.
 */
const f = (name: string) => `/art/final/${name}.webp`;

const b = (name: string, w: number, h: number) => ({ src: `/art/final/characters/bust/${name}.webp`, w, h });

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
   * Guide characters, torso-up crops only (made by scripts/make-busts.mjs from the full-body poses,
   * which are never shown). him = the Player / guide; her = the Backer. w/h are the crop's pixels.
   * Placement rules are in DESIGN.md.
   */
  busts: {
    himWelcome: b("him-welcome", 302, 310),
    himExplain: b("him-explain", 391, 318),
    himWin: b("him-win", 278, 319),
    himLose: b("him-lose", 256, 300),
    himWaiting: b("him-waiting", 240, 297),
    herBacking: b("her-backing", 346, 334),
    herEmpty: b("her-empty", 284, 275),
    herWaitingCrosschain: b("her-waiting-crosschain", 294, 308),
    duoHero: b("duo-hero", 558, 322),
    duoWin: b("duo-win", 687, 318),
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
