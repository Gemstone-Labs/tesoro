# Desktop lobby — three directions

- `take-1.png`: A, Cut, lit — restrained shell and illuminated game art.
- `take-2.png`: B, Treasure hall — richer faceted hero, greater saturation, Hot/New badges.
- `take-3.png`: C, Arcade cut — tactile pressed edges, toy-like blocks, solid emerald money controls.

All three use the same layout/content brief. Generated with the built-in image_gen tool, followed by one targeted refinement pass per direction. Exact prompts and ordered attachments are in `../PROMPTS-log.md`.

## Export verification

Final PNGs are 1920×1200 RGB. Native generated images are 1586×992 and are preserved in `native/take-N.png`; first renders are preserved as `native/take-N-draft.png`. Final exports use Lanczos resampling, not native 1920×1200 generation. Decoding, dimensions and SHA-256 checks are recorded in `QA.json`.

## Visual review

All three show a desktop sidebar, wide hero with a second slide, six game tiles, recent Matches, settlement ticker, three player cards and footer. They preserve the two live games and four upcoming games. Core amounts, entry choices and the simulation/devnet line are visible. The upcoming games are dimmed more clearly after refinement. The three surface/art directions are visibly differentiated.

Remaining mockup deviations: the six game cards are still slightly landscape rather than exactly square; A/B use a circular carousel-next control; B retains emerald Live labels, and C retains a small emerald edge on its ticker icon. A/C do not explicitly label the first two tiles Live. A/B's ticker has the settlement text but omits the Live now heading. Fine footer text is generated and needs deterministic typesetting during implementation. These are concept images, not pixel-exact layout or font specimens; Schibsted Grotesk was requested, not technically embedded.

Source references are the current repository brief and attachments. The previous Obsidian Tesoro folder is archived; it was not restored or changed. No app code was changed.
