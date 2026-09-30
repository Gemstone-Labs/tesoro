/**
 * Every piece of game art and avatar the UI shows, in one map. Today these are PLACEHOLDER crops of
 * the approved mockup (`app/scripts/crop-placeholder-art.mjs`, `public/art/placeholder/`). When the
 * real assets land (art-source/ui-redesign/assets/), copy them to `public/art/` and change the
 * one line for each image here.
 */
const p = (name: string) => `/art/placeholder/${name}.png`;

export const art = {
  /** Wide hero art, left 40% dark and empty for the title. PLACEHOLDER: crop of take-1. */
  blockPuzzleHero: p("block-puzzle-hero"),
  /** PLACEHOLDER: crop of take-1 (final is 2400x1000 with the left 40% dark). */
  holdemHero: p("holdem-hero"),
  /** Square key art. PLACEHOLDER. */
  blockPuzzleTile: p("block-puzzle-tile"),
  holdemTile: p("holdem-tile"),
  comingSoon: {
    "word-duel": p("coming-soon-word-duel"),
    "bubble-burst": p("coming-soon-bubble-burst"),
    "pocket-pool": p("coming-soon-pocket-pool"),
    "trivia-sprint": p("coming-soon-trivia-sprint"),
  },
  /** Landscape thumbs for Play Again. PLACEHOLDER: crops of take-1 (final: reuse the tiles). */
  thumb: {
    "block-puzzle": p("block-puzzle-thumb"),
    holdem: p("holdem-thumb"),
  },
  /** Demo/seed avatars. PLACEHOLDER: three crops of take-1 (final art ships avatar-1..6). */
  avatars: [p("avatar-1"), p("avatar-2"), p("avatar-3")],
} as const;

/** A stable avatar for a Player key, so the same Player always shows the same face. */
export function avatarFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return art.avatars[h % art.avatars.length];
}
