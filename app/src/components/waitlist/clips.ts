/** The wall's clips (public/art/waitlist, made by scripts/import-waitlist-clips.mjs). Three columns, three clips each. */
export const WALL_COLUMNS: number[][] = [
  [1, 4, 7],
  [2, 5, 8],
  [3, 6, 9],
];
export const CLIP_SIZE = { width: 480, height: 854 };
/** Start on load; the rest wait for an idle moment. The phone shows the first two of columns one and two. */
export const FIRST_CLIPS = 4;
