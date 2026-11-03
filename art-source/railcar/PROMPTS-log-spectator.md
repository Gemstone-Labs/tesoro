# Railcar — spectator prompt log

## Final outputs and self-check

Additional verification: a dependency-free Python standard-library check read each PNG's signature and IHDR dimensions, checked three distinct SHA-256 hashes, verified that the spectator directory contains exactly the three requested outputs, and confirmed all six image_gen prompts plus this self-check are logged. Result: PASS. An initial Pillow-based version could not run because PIL is not installed; the same dimension checks were completed using struct without installing dependencies. ImageMagick identify also passed independently as recorded below.

Tool: built-in image_gen. Separate generation calls for sp1, sp2 and sp3; targeted edits logged above. Initial calls each attached the five common reference images. Edit calls attached 5, 3 and 2 images respectively, always within the five-image limit.

Final selected source PNGs:
- sp1: /home/ailton/.codex/generated_images/01a1a0ac-7d3f-7ce0-aef1-e26316168522/exec-455a47c7-d96c-4927-8cec-1757cf0048d3.png
- sp2: /home/ailton/.codex/generated_images/01a1a0ac-7d3f-7ce0-aef1-e26316168522/exec-a2c75a72-061b-4feb-a15c-02d0f31f2cb9.png
- sp3: /home/ailton/.codex/generated_images/01a1a0ac-7d3f-7ce0-aef1-e26316168522/exec-40e33b0d-fd6e-437c-ba68-dfb5e5b8e88d.png

Each final was resized with ImageMagick Lanczos and centered extent; no UI was redrawn outside image_gen:
```bash
magick SOURCE.png -filter Lanczos -resize '390x844^' -gravity center -extent 390x844 spectator/spN-390.png
magick identify spectator/sp1-390.png spectator/sp2-390.png spectator/sp3-390.png
```

Actual identify result (exit 0):
```text
spectator/sp1-390.png PNG 390x844 390x844+0+0 8-bit sRGB 410672B
spectator/sp2-390.png PNG 390x844 390x844+0+0 8-bit sRGB 431586B
spectator/sp3-390.png PNG 390x844 390x844+0+0 8-bit sRGB 397752B
```

Visual review performed on all three final 390x844 PNGs using view_image, after resize. This is a static image review, not app or animation verification.

| Common-brief self-check | sp1 | sp2 | sp3 |
|---|---|---|---|
| Exactly 390x844 PNG | PASS | PASS | PASS |
| Chamfered cards, chips, buttons, art windows and avatar frames; thin lit outlines | PASS | PASS | PASS |
| Neutral chrome; emerald restricted to Gemas value/mark and main money button; saturated cave/animal reference art retained | PASS | PASS | PASS |
| No gold UI; no red loss UI; no amber Tell UI | PASS | PASS | PASS |
| Exact required copy legible at final 390px width | PASS | PASS | PASS |
| Signed-out slim header: Tesoro mark, Live with neutral pulse marker, Sign in | PASS | PASS | PASS |
| Clock 0:52; Tells 1 lit, 2 and 3 dim | PASS | PASS | PASS |
| Aboard 44; six correct reference animal identities and names | PASS | PASS | PASS |
| At stake diamond 22,000; Play the next ride; Boarding next: 12 aboard | PASS | PASS | PASS |
| No Jump/Brake, bottom nav, signed-in chrome, search, chat, missions or online avatar dots | PASS | PASS | PASS |
| No wall, hidden wall distance, speed, travelled distance, live refund percentage or forbidden jargon | PASS | PASS | PASS |
| Distinct layouts with identical content | PASS: forward track + 3x2 roster | PASS: broadside car + two ticker lanes | PASS: overhead diagonal cart + split vertical manifest |

Only the spectator screen was produced.


## sp2 — targeted edit 2

Target: sp2 targeted edit 1. References: target and attach/30-avatars.png (2 total). Removes warm avatar-frame highlights introduced by the previous edit.

```text
Use case: precise-object-edit / ui-mockup.
Reference image 1 is the only edit target: finished Railcar broadcast spectator screen. Make a tiny neutral-color correction ONLY to the six octagonal avatar borders in the two ticker lanes. ALL six frames must have an identical thin flat cool-grey outline (#75828A) with a subtle grey top edge. Remove every warm yellow/gold/beige, green, blue or tinted metallic highlight from these borders. No colored reflection from the animals, no gold rim, no thick bright silver bezel. The gemstone animals themselves retain their exact existing colors and appearance from reference image 2.
Preserve all other pixels, art, text, layout, sizes, cut geometry and colors as closely as possible. Keep every exact required string: Live; Sign in; RAILCAR; At stake; emerald diamond and emerald 22,000; 0:52; Tells; stage numbers 1,2,3; Aboard 44; Nadia; Juno; Rocco; Big L; kai.sol; Mira; Play the next ride; Boarding next: 12 aboard. Stage 1 lit off-white and 2/3 dim. No new text, controls, nav, wall or live metrics. Output one full-screen screenshot, portrait 390:844 aspect.
```


## sp1 — targeted edit 1

Target: original sp1; references: target plus attach/11-now-block-burst-390.png, attach/13-now-play-390.png, attach/30-avatars.png, attach/cave-hero.png (5 total).

```text
Use case: precise-object-edit / ui-mockup.
Edit only the typography and the Gemas value color of reference image 1 (the finished forward-track spectator screen). Preserve its excellent composition, geometry, cave art, camera, railcar, exact six gemstone animal identities, dark materials, cut corners, every position, every content value, stage 1 lit and stages 2/3 dim.
Reference 2 is neutral game chrome, reference 3 Tesoro app cut-button typography, reference 4 the exact six animal identities, reference 5 the cave materials. Image 1 is the sole edit target.
Required corrections: make BOTH the Gema diamond AND the entire amount 22,000 emerald #24D8A8 (currently only the diamond is emerald). Keep other figures white. Change label case to exact mixed case: "Aboard 44", "At stake", "Nadia", "Juno", "Rocco", "Big L", "kai.sol", "Mira", "Play the next ride". Keep "RAILCAR" in heavy condensed uppercase. Keep top row exactly neutral Tesoro mark, "Live" with its neutral pulse dot, "Sign in". Keep the footer small line "Boarding next: 12 aboard" unchanged. Render elapsed clock "0:52" with clean monospaced tabular numerals. No extra text.
Output a single full-screen portrait screenshot at the same 390:844 aspect, no device frame, no outer margin. Do not add controls, bottom nav, any new statistic, sparks, humans, wall, speed/distance/refund information. Every card/chip/button/avatar frame stays octagonal/chamfered.
```

## sp2 — targeted edit 1

Target: original sp2; references: target plus attach/30-avatars.png and attach/11-now-block-burst-390.png (3 total).

```text
Use case: precise-object-edit / ui-mockup.
Edit reference image 1, the finished Tesoro Railcar broadcast spectator screen. Change ONLY the six aboard avatar presentations in the two ticker lanes: add a crisp small octagonal CHAMFERED neutral metal frame with thin lit outline around EACH of the existing six gemstone animal heads. These are six separate octagon avatar frames, not merely the long ticker lane's cut corners. Preserve all six heads and identities exactly from reference 2 (Nadia amber toucan, Juno pink axolotl, Rocco purple owl; Big L yellow lion, kai.sol red fox, Mira silver zebra). Do not crop heads or shrink the labels beyond legibility.
Preserve absolutely everything else in image 1: side-on car game art, composition and positions, slim signed-out header, "Live" with neutral pulse dot, "Sign in", "RAILCAR", "At stake" with emerald diamond AND emerald "22,000", clock "0:52", "Tells" with stage 1 lit white and 2/3 dim, "Aboard 44", every exact mixed-case name, emerald "Play the next ride" button and exact footer "Boarding next: 12 aboard". No added text, no extra numbers, no humans, no wall, no nav, no controls, no speed/distance/refund information.
Reference 1 sole edit target. Reference 2 exact animal identity. Reference 3 dark chamfered Tesoro chrome. Output single full-screen portrait at same 390:844 aspect, no device frame, no outer margin.
```


For sp2 and sp3 generation 1, the following precision paragraph is appended verbatim to each corresponding prompt below:

```text
TYPE AND COLOR PRECISION: The Gema diamond AND the digits "22,000" must both be emerald #24D8A8. Keep all other stat values white. Use mixed-case grotesque labels exactly "Aboard", "At stake", "Nadia", "Juno", "Rocco", "Big L", "kai.sol", "Mira", "Play the next ride", "Sign in", "Live", "Tells"; only RAILCAR is uppercase. Timer 0:52 must use monospaced tabular numerals. Top row genuinely slim, not a large masthead.
```

Built-in image_gen. Each take generated separately with all five listed references; no other screen requested.

References per generation:
1. `/home/ailton/Work/gemstone-labs/tesoro/art-source/railcar/attach/11-now-block-burst-390.png`
2. `/home/ailton/Work/gemstone-labs/tesoro/art-source/railcar/attach/13-now-play-390.png`
3. `/home/ailton/Work/gemstone-labs/tesoro/art-source/railcar/attach/23-tile-block-burst.png`
4. `/home/ailton/Work/gemstone-labs/tesoro/art-source/railcar/attach/30-avatars.png`
5. `/home/ailton/Work/gemstone-labs/tesoro/art-source/railcar/attach/cave-hero.png`

## sp1 — generation 1

```text
Use case: ui-mockup.
Create ONE finished Tesoro Railcar signed-out spectator mobile screen. Portrait aspect ratio exactly 390:844, ideally native 390x844, otherwise same aspect at higher resolution. Flat edge-to-edge screenshot with no phone hardware, no rounded screen corners, no outer margins. All UI fits one screen.
Attached reference roles, in order: 1 game-screen neutral dark metal chamfered UI; 2 Tesoro app material/type and cut-button style ONLY, do not copy its app navigation or its games; 3 chunky faceted gem game-art rendering style ONLY, no puzzle pieces; 4 exact six gemstone animal heads; 5 Tesoro cave, lighting and materials.
VISUAL SYSTEM: shell #090D0F, raised #11161A/#171E25, text #EAEFEC. Every card, chip, button, avatar frame, icon tile and art viewport has straight chamfered/octagonal cut corners and a thin lit outline, brighter on top. Never rounded rectangles or pills. Clean polished restrained mobile UI, strong readable hierarchy, Barlow Condensed style heavy condensed all-caps for RAILCAR and large figures, clean grotesque for normal labels, tabular numerals, monospace only clock. Emerald #24D8A8 is restricted to the small Gema diamond with 22,000 and the main money button; gem-lit cave art may have its own restrained colors. All other UI white/grey, including Live pulse dot and Tell stage 1. No gold UI, no red UI. Gem animal heads are exactly reference 4 in six octagonal neutral frames: Nadia amber toucan, Juno pink axolotl, Rocco purple owl, Big L yellow lion, kai.sol red fox, Mira silver zebra. No humans, no human riders, no invented avatars. No signed-in user highlight because this viewer is signed out.
EXACT REQUIRED CONTENT ONCE EACH: slim top row with neutral Tesoro geometric mark at left, a small "Live" tag with one neutral pulse dot, and a cut "Sign in" chip at right. Title "RAILCAR". Clock "0:52" counting upward since departure, without a progress gauge or predicted finish. Tells row labeled "Tells" with three cut stages marked "1", "2", "3": stage 1 visibly lit off-white with a loose screw icon; stages 2 and 3 dark grey and dim (a bolt/panel and sparks icons). No amber on these UI indicators. "Aboard 44" and an aboard avatar list using the exact six avatars and names "Nadia", "Juno", "Rocco", "Big L", "kai.sol", "Mira". These are the visible portion of 44 aboard, not a claim there are only six. "At stake" with emerald diamond Gema mark and "22,000". One large emerald chamfered main button labeled exactly "Play the next ride". Small line exactly "Boarding next: 12 aboard".
GAME ART: a chunky cut faceted dark metal mine railcar riding steel rails within the gem-lit deep cave from reference 5. Stylized premium game art, neither cartoon nor photorealistic. Restrained blue-grey stone and metal, a few glowing cave crystals, cinematic directional light. Wall/impact point must remain completely hidden by darkness and tunnel bend. Stage 1 Tell is a subtle loose screw by the cart; no sparks in the live art yet.
NEVER SHOW: Jump, Brake, ride controls, bottom navigation, signed-in top bar, Pool chest, wallet balance, search, chat, missions, online dots by avatars, paragraphs, invented statistics, entry/fee/refund figures. No car speed, no distance, no distance travelled, no hidden wall distance, no refund percentage. No numbers beyond those explicitly specified. Never write speed, distance, crash point, VRF, rollup, Seed, TEE. Only clock measures elapsed ride. Ensure every exact string is legible at 390px.

TAKE sp1 — SAME VIEW / TRACK AHEAD. A compact signed-out header at y=16–54, RAILCAR title and big clock 0:52 in a slim row underneath. Hero art at approximately y=120–440: forward rider's viewpoint from just behind the front rim of the mine cart, looking down converging rails into a dark cave bend, no wall visible. No anthropomorphic riders in cart. Tells as a narrow 3-stage strip immediately under the hero. Under that a compact Aboard 44 / At stake ◆22,000 header, then a 3-column by 2-row roster with all six small exact animal heads and names. Footer button near y=742–795 and boarding line beneath, comfortably inside screen. Do not introduce a spectator caption or any extra copy.
```

## sp2 — generation 1

```text
Use case: ui-mockup.
Create ONE finished Tesoro Railcar signed-out spectator mobile screen. Portrait aspect ratio exactly 390:844, ideally native 390x844, otherwise same aspect at higher resolution. Flat edge-to-edge screenshot with no phone hardware, no rounded screen corners, no outer margins. All UI fits one screen.
Attached reference roles, in order: 1 game-screen neutral dark metal chamfered UI; 2 Tesoro app material/type and cut-button style ONLY, do not copy its app navigation or its games; 3 chunky faceted gem game-art rendering style ONLY, no puzzle pieces; 4 exact six gemstone animal heads; 5 Tesoro cave, lighting and materials.
VISUAL SYSTEM: shell #090D0F, raised #11161A/#171E25, text #EAEFEC. Every card, chip, button, avatar frame, icon tile and art viewport has straight chamfered/octagonal cut corners and a thin lit outline, brighter on top. Never rounded rectangles or pills. Clean polished restrained mobile UI, strong readable hierarchy, Barlow Condensed style heavy condensed all-caps for RAILCAR and large figures, clean grotesque for normal labels, tabular numerals, monospace only clock. Emerald #24D8A8 is restricted to the small Gema diamond with 22,000 and the main money button; gem-lit cave art may have its own restrained colors. All other UI white/grey, including Live pulse dot and Tell stage 1. No gold UI, no red UI. Gem animal heads are exactly reference 4 in six octagonal neutral frames: Nadia amber toucan, Juno pink axolotl, Rocco purple owl, Big L yellow lion, kai.sol red fox, Mira silver zebra. No humans, no human riders, no invented avatars. No signed-in user highlight because this viewer is signed out.
EXACT REQUIRED CONTENT ONCE EACH: slim top row with neutral Tesoro geometric mark at left, a small "Live" tag with one neutral pulse dot, and a cut "Sign in" chip at right. Title "RAILCAR". Clock "0:52" counting upward since departure, without a progress gauge or predicted finish. Tells row labeled "Tells" with three cut stages marked "1", "2", "3": stage 1 visibly lit off-white with a loose screw icon; stages 2 and 3 dark grey and dim (a bolt/panel and sparks icons). No amber on these UI indicators. "Aboard 44" and an aboard avatar list using the exact six avatars and names "Nadia", "Juno", "Rocco", "Big L", "kai.sol", "Mira". These are the visible portion of 44 aboard, not a claim there are only six. "At stake" with emerald diamond Gema mark and "22,000". One large emerald chamfered main button labeled exactly "Play the next ride". Small line exactly "Boarding next: 12 aboard".
GAME ART: a chunky cut faceted dark metal mine railcar riding steel rails within the gem-lit deep cave from reference 5. Stylized premium game art, neither cartoon nor photorealistic. Restrained blue-grey stone and metal, a few glowing cave crystals, cinematic directional light. Wall/impact point must remain completely hidden by darkness and tunnel bend. Stage 1 Tell is a subtle loose screw by the cart; no sparks in the live art yet.
NEVER SHOW: Jump, Brake, ride controls, bottom navigation, signed-in top bar, Pool chest, wallet balance, search, chat, missions, online dots by avatars, paragraphs, invented statistics, entry/fee/refund figures. No car speed, no distance, no distance travelled, no hidden wall distance, no refund percentage. No numbers beyond those explicitly specified. Never write speed, distance, crash point, VRF, rollup, Seed, TEE. Only clock measures elapsed ride. Ensure every exact string is legible at 390px.

TAKE sp2 — BROADCAST. Clearly different composition from a forward track view: a compact header followed by large RAILCAR title at upper left and At stake ◆22,000 aligned right. A wide side-on cinematic art viewport in the middle upper screen, at approximately y=160–430, shows the full faceted dark metal railcar broadside on a horizontal rail through the cavern. Do not show a wall. A large clock 0:52 sits in an angular neutral overlay on the top left of that viewport, with Tells in a three-cell strip below the art. Then a strong Aboard 44 heading above an aboard ticker beneath the side-view art: two slim horizontal ticker lanes, each with three small reference-animal heads and corresponding names, so all six Nadia, Juno, Rocco / Big L, kai.sol, Mira are fully readable, the lanes suggest horizontal motion by cut edge marks, no motion numeric labels. Plenty of breathing room. Tidy cut-panel footer with emerald Play the next ride button and Boarding next: 12 aboard. Broadcast feel without adding any broadcast words or other statistics.
```

## sp3 — generation 1

```text
Use case: ui-mockup.
Create ONE finished Tesoro Railcar signed-out spectator mobile screen. Portrait aspect ratio exactly 390:844, ideally native 390x844, otherwise same aspect at higher resolution. Flat edge-to-edge screenshot with no phone hardware, no rounded screen corners, no outer margins. All UI fits one screen.
Attached reference roles, in order: 1 game-screen neutral dark metal chamfered UI; 2 Tesoro app material/type and cut-button style ONLY, do not copy its app navigation or its games; 3 chunky faceted gem game-art rendering style ONLY, no puzzle pieces; 4 exact six gemstone animal heads; 5 Tesoro cave, lighting and materials.
VISUAL SYSTEM: shell #090D0F, raised #11161A/#171E25, text #EAEFEC. Every card, chip, button, avatar frame, icon tile and art viewport has straight chamfered/octagonal cut corners and a thin lit outline, brighter on top. Never rounded rectangles or pills. Clean polished restrained mobile UI, strong readable hierarchy, Barlow Condensed style heavy condensed all-caps for RAILCAR and large figures, clean grotesque for normal labels, tabular numerals, monospace only clock. Emerald #24D8A8 is restricted to the small Gema diamond with 22,000 and the main money button; gem-lit cave art may have its own restrained colors. All other UI white/grey, including Live pulse dot and Tell stage 1. No gold UI, no red UI. Gem animal heads are exactly reference 4 in six octagonal neutral frames: Nadia amber toucan, Juno pink axolotl, Rocco purple owl, Big L yellow lion, kai.sol red fox, Mira silver zebra. No humans, no human riders, no invented avatars. No signed-in user highlight because this viewer is signed out.
EXACT REQUIRED CONTENT ONCE EACH: slim top row with neutral Tesoro geometric mark at left, a small "Live" tag with one neutral pulse dot, and a cut "Sign in" chip at right. Title "RAILCAR". Clock "0:52" counting upward since departure, without a progress gauge or predicted finish. Tells row labeled "Tells" with three cut stages marked "1", "2", "3": stage 1 visibly lit off-white with a loose screw icon; stages 2 and 3 dark grey and dim (a bolt/panel and sparks icons). No amber on these UI indicators. "Aboard 44" and an aboard avatar list using the exact six avatars and names "Nadia", "Juno", "Rocco", "Big L", "kai.sol", "Mira". These are the visible portion of 44 aboard, not a claim there are only six. "At stake" with emerald diamond Gema mark and "22,000". One large emerald chamfered main button labeled exactly "Play the next ride". Small line exactly "Boarding next: 12 aboard".
GAME ART: a chunky cut faceted dark metal mine railcar riding steel rails within the gem-lit deep cave from reference 5. Stylized premium game art, neither cartoon nor photorealistic. Restrained blue-grey stone and metal, a few glowing cave crystals, cinematic directional light. Wall/impact point must remain completely hidden by darkness and tunnel bend. Stage 1 Tell is a subtle loose screw by the cart; no sparks in the live art yet.
NEVER SHOW: Jump, Brake, ride controls, bottom navigation, signed-in top bar, Pool chest, wallet balance, search, chat, missions, online dots by avatars, paragraphs, invented statistics, entry/fee/refund figures. No car speed, no distance, no distance travelled, no hidden wall distance, no refund percentage. No numbers beyond those explicitly specified. Never write speed, distance, crash point, VRF, rollup, Seed, TEE. Only clock measures elapsed ride. Ensure every exact string is legible at 390px.

TAKE sp3 — OVERHEAD / MANIFEST. An original third layout, clearly different from both forward-track and broadside broadcast. Slim signed-out header. RAILCAR title centered above a shallow wide hero window around y=100–330 that looks steeply down at the faceted railcar from an overhead three-quarter angle, rails crossing diagonally through the gem cave and disappearing into darkness, no wall. Beneath the window use an asymmetric dashboard split: a narrow left column around 118px wide containing a large 0:52 clock, then stacked Tells 1/2/3 with only 1 lit, then At stake over emerald ◆22,000; the wider right column is a vertical aboard manifest headed Aboard 44 with six separate slim horizontal cut rows, each exact animal head beside its name (Nadia, Juno, Rocco, Big L, kai.sol, Mira). This split section occupies roughly y=350–705. Full-width emerald Play the next ride button anchored near bottom and Boarding next: 12 aboard beneath it. No extra labels or statistics.
```

