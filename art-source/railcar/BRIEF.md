# Railcar: UI mockups (brief for Astra)

Same job as `../mobile-first/BRIEF-3.md`: **phone mockups at exactly 390x844**, clearly different takes per screen (3 each), the founder picks one per screen. Read `../mobile-first/BRIEF.md` sections "The look", "Top bar" and "Bottom nav" first; they all apply. Do ONLY the screen you are assigned, then stop.

## What Railcar is

A new Tesoro Game for 5 to 100 Players. Everyone pays an entry of 500 Gemas and boards one car that runs on a track toward a wall at a hidden distance. Each Player chooses when to **Jump** off. The **last three Players off before Impact** each get their entry back and share the rest of the Pot (60/25/15). Players still aboard at Impact lose their entry. Players who Jump early get a smaller entry refund back (the later, the less). If nobody Jumps, everyone is refunded. Each Player has one secret **Brake** (the car slows for everyone, but only that Player knows). **Tells** warn as the wall nears, in three stages: (1) loose screws, (2) a bolt and a rattling panel, (3) sparks and a creak.

Art world: a mine cart / railcar on rails in the Tesoro cave (see `attach/cave-hero.png` for the cave, light and materials). Chunky cut, faceted, gem-lit; not cartoon, not photoreal. Keep Tesoro's restraint: the game art is the only saturated colour.

## The look (every image)

- Tesoro chrome as in the mobile-first brief: near-black `#090D0F`, raised `#11161A` / `#171E25`, off-white `#EAEFEC`; every card, chip, button and avatar frame has **chamfered (octagonal) corners** with a thin lit outline; no rounded rectangles or pills.
- **Emerald `#24D8A8` only for Gemas amounts (with the small Gema mark), and the main money button.** Gold only for the Pool chest. Danger (muted red `#F2685A`) only for loss. Amber/warn `#F2B94B` may colour the Tell sparks inside the game art only.
- Type: heavy condensed all-caps display (Barlow Condensed style) for big figures and titles; clean grotesque for UI; tabular numerals; monospace only for timers and hashes.
- Avatars: exactly the six gemstone animals in `attach/30-avatars.png` (1 Nadia = you, 2 Juno, 3 Rocco, 4 Big L, 5 kai.sol, 6 Mira). Never draw people. Where more Players than six are named, repeat these six avatars with other short names (Ada, Teo, Lux, Remy, Zed, Pia, Sol, Noor).
- No paragraphs of text. No chat, no missions, no search box, no online dots.
- **Game screens (Boarding, Ride) have no bottom nav and no signed-in top bar**: a slim top row only (back chevron or a small info icon, as in `attach/11-now-block-burst-390.png`). **Result, Round history** are app screens: top bar (menu, gold Pool chest 130, emerald Gemas pill, avatar 1) and bottom nav (Matches 1, Friends 2, raised emerald PLAY, Leaderboard, Vault) with no tab lit, as in `attach/13-now-play-390.png`. The Spectator screen has a signed-out slim top row with a "Sign in" chip instead.
- Plain words. Never write: speed, distance, percent refund (on the Ride screen), crash point (during a ride), VRF, rollup, Seed, TEE.
- **Never show the hidden wall distance, the car's speed, the distance travelled, or a live refund percentage on any live screen (Boarding, Ride, Spectator).** On those screens time is shown only as a clock counting up since departure.

## Common content

Game name **Railcar**. Entry **500** (Gema mark). Fee for the Pot is not shown on live screens.

## Screens and takes

Each screen is a section file: `SCREEN-boarding.md`, `SCREEN-ride.md`, `SCREEN-result.md`, `SCREEN-spectator.md`, `SCREEN-history.md`. Outputs go to `railcar/<screen>/<code>1-390.png` ... `<code>3-390.png` (codes: bo, ri, re, sp, hi) as exact 390x844 PNGs. Log every prompt in `PROMPTS-log-<screen>.md`.

## Attachments (`art-source/railcar/attach/`)

`11-now-block-burst-390.png` (game screen frame), `13-now-play-390.png` (app screen frame, top bar, nav), `23-tile-block-burst.png` (game tile art style), `30-avatars.png`, `cave-hero.png` (cave, light, materials). Pass at most five referenced images per generation.

## Self-check before saving each image

Exactly 390x844; every corner chamfered; emerald only on Gemas and the main money button; text spelled exactly as written and legible at 390 px; no forbidden items above; the three takes of a screen are clearly different layouts with identical content; numbers match this brief exactly (they come from the spec's worked example).
