# Railcar round 2 (brief for Astra)

Style: same as BRIEF.md (Tesoro cave, faceted gem-lit, chunky, not cartoon). Founder wants the car to be a REAL railway car, recognisable as a train car.

## Job A: fix bo1's vehicle in place -> `round2/bo1-fixed-raw.png`
Input: `round2/bo1-orig.png` (390x844 as given, attached). Edit ONLY the vehicle (the grey box on rails around y 360-540). Replace it with a real railway passenger/freight-style car in side view: long body, roof with a slight curve, a row of arched windows with the Players' gem-animal heads (avatars from attach/30-avatars.png, small, in the windows, many windows filled, a few empty), a coupler at each end, two bogies with spoked/flanged wheels on the rails, small lamp at the front. Same position, same width (about x 8-382), same lighting and cave behind. Everything else (title, countdown, aboard card, avatar strip, buttons, texts) must stay pixel-identical. Output a 390x844 PNG.

## Job B: sprite sheet pieces for an animated side-view ride (each on a flat solid #FF00FF magenta background, no shadows on the key, crisp edges)
1. `round2/car-sprite.png`: the SAME railcar as Job A, side view facing right, whole car incl. wheels and couplers, 1400x400, centred, windows left EMPTY (dark glass) so avatars can be overlaid by code. Wheels drawn at fixed positions, 2 bogies.
2. `round2/wheel.png`: one wheel of that car, front-on side view, 160x160, spokes visible, for rotation.
3. `round2/bg-far.png`: wide cave background, 2400x600, left and right edges tile seamlessly, no rails, no magenta (normal opaque image), dim blue-teal depth with emerald crystals, cave arches.
4. `round2/bg-mid.png`: 2400x600 tileable mid layer of rock columns and crystal clusters with a transparent... use magenta #FF00FF key for sky/empty parts so it can overlay bg-far.
5. `round2/track.png`: 2400x200 tileable rails with wooden sleepers in side view and gravel, magenta key above the ground.
Log prompts in `PROMPTS-log-round2.md`. Verify sizes with magick identify. Stop after.
