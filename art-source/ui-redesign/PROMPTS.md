# Tesoro UI redesign (brief for Astra)

Feedback (Ailton, Sep 30): "the UI looks too basic and it's mobile-looking. This should run in a browser as well, not only mobile. Take Skillz / Chumba as reference and come up with something more interesting."

Astra paints full-screen **UI mockups** as images. Claude then rebuilds the chosen screens in code (Next.js), so the images are the design, not assets: code redoes all text, numbers and icons. Minor garbled text in the images is fine; wrong layout or hierarchy is not.

This brief has two phases:

- **Phase 1 (now):** the desktop Lobby in three directions, A, B and C. Ailton picks one, or a mix.
- **Phase 2 (after the pick):** every other screen in the chosen direction, desktop first plus the key mobile screens. The prompts are below, so they can run as soon as a direction is picked.

## What Tesoro is (for the painter)

Tesoro is a skill-gaming platform on Solana. A player locks a staking position (SOL, ETH or HYPE). Tesoro immediately advances the position's future yield as **Gemas**, the in-app play currency. The player spends Gemas on head-to-head Matches, and the locked principal is never at risk. Winners redeem their winnings as the losers' yield accrues. Stakers can also **back** other players by funding their entry and sharing the win. There are two games today: **Block Puzzle** (async, same-seed, 90 seconds) and **heads-up Hold'em** (real-time poker).

The feel we want: a premium game lobby where the games are the star. The density and energy of Chumba's lobby and the clean game-first shelves of Skillz. It should be unmistakably Tesoro, never a casino clone.

## Shared rules (every image)

- **Brand.**
  - **Base:** a near-black neutral shell (`#0C0E10`, raised surfaces `#15181B`), off-white text (`#EAEFEC`).
  - **Accent:** one jewel accent, **emerald** (`#2DBE8C`, highlight `#8FF5CF`, deep `#0B6B4E`). Emerald marks where Gemas move: balances, entry buttons, Redeem, Offer and Enter.
  - **Shape language:** chamfered, octagonal "emerald-cut" corners on cards, buttons and chips instead of rounded pills. This is the signature (reference 9).
  - **Gema mark:** a small faceted emerald-cut gem, never a coin and never gold.
- **More interesting than today.**
  - **Game art:** rich, lit and full of colour, both in key art tiles and in hero banners.
  - **Surfaces:** depth, faceted light on money surfaces, and subtle gem-facet textures are allowed.
  - **Composition:** confident, desktop-native composition (multi-column, left navigation, hero carousel, rails).
  - **Not allowed:** casino red and gold, neon glow everywhere, green felt as chrome, and Skillz purple.
- **Desktop first.** Canvas 1920×1200 (16:10), a real browser layout, not a stretched phone. Mobile screens are 1170×2532.
- **Real content.** Use these exact figures and words so the design is honest:
  - **Balance:** 15,000 Gemas (1 Gema = $0.01).
  - **Entries:** 500 / 1,000 / 2,500 Gemas.
  - **Balance split:** "Redeemable now 1,240" and "Pending 3,760".
  - **Chains:** SOL, ETH and HYPE chips.
  - **Label:** "Simulated yield · 1 month = 10 min", small, wherever yield or balances appear.
  - **Terms:** Position, Advance, Debt, Unlock Estimate, Redeem, Backing, Request, Offer, Match, Queue, Challenge.
  - **Do not use:** coins, bet, jackpot, cash out, casino, token, ORO or credit.
- **No real brand logos** (no Skillz, Chumba, Solana or Ethereum marks). Chain chips are text only.
- **Delivery:**
  - Save images as `art-source/ui-redesign/<screen>/take-N.png`.
  - Append the exact prompt you ran, and the attachments in order, to `art-source/ui-redesign/PROMPTS-log.md` (create it).
  - Don't touch `app/` and don't commit.

## Attachments

Everything is in `art-source/ui-redesign/attach/`.

| # | File | Use |
|---|---|---|
| 1 | `01-today-lobby-desktop.png` | Today's desktop Lobby. Context only: too basic, and it reads as a phone layout |
| 2 | `02-today-lobby-mobile.png` | Today's mobile Lobby, as context |
| 3 | `03-today-block-puzzle.png` | Block Puzzle as it is today: 8×8 board, pieces tray, 90-second clock, emerald gem cells |
| 4 | `04-today-holdem-desktop.png` | Hold'em today |
| 5 | `05-today-wallet.png` | Wallet today |
| 6 | `06-today-backing.png` | Backing today |
| 7 | `07-today-result.png` | Match result today |
| 8 | `08-today-cross-chain.png` | Cross-chain progress today |
| 9 | `09-brand-emerald-study.html` | The approved "Cut" brand direction (screenshot the "Cut" row) |
| 10 | `10-ref-skillz-desktop.jpg` | **Main reference.** Skillz web lobby: fixed left sidebar (logo, badge, Lobby / Recommended / Categories / Play Games Now, then Support / Legal / Help), centred hero card with a GO button and carousel dots, a row of category chips with icons, many rails of square game tiles with bold condensed all-caps section headers, "VIEW ALL" links and ← → arrows, footer. Take its structure and rhythm; not its purple, logos or art |
| 11 | `11-ref-chumba-desktop.jpg` | Secondary reference. Chumba: balance pill centred in the top bar, top category tabs, a full-bleed cinematic hero banner with a stat pill ("Jackpot") and one strong CTA, then a "Play Again" rail of large landscape tiles with a heart. Take the hero drama and the landscape tiles; not its red, gold, casino content or logos |

---

## Phase 1: desktop Lobby, three directions

Screen folder: `lobby-desktop/`. Make **take-1 (A), take-2 (B) and take-3 (C)** from the same layout brief, varying only the direction.

**Layout brief (all three). The skeleton is Skillz (reference 10); the hero drama is Chumba (reference 11):**
- **Left sidebar, fixed, like Skillz:** the Tesoro wordmark and gem mark, a small "Fair play · on-chain" badge, then Lobby, Play, Backing, Wallet, and below a divider Docs, Help. Below that sits the "Your Positions" mini-card: SOL 40 · Debt 0.550 · Unlock Estimate, plus Redeemable now / Pending.
- **Top bar:** search on the left; on the right the Gema balance pill (gem mark + "15,000") centred like Chumba's balance pill, then the Account avatar.
- **Category chips row, like Skillz:** Puzzle, Cards, Head-to-head, Async, Backing, each with a small icon.
- **Hero carousel:**
  - The big slide is "Block Puzzle": dramatic key art of glowing coloured blocks and emerald gem blocks on a dark board, with "Same Seed · 90 seconds · higher score wins", an entry picker (500 / 1,000 / 2,500) and an emerald **Play now** button.
  - A second slide peeks in: "Heads-up Hold'em".
- **Game rails, like Skillz:** bold condensed all-caps headers with "VIEW ALL" and ← → arrows. The "Play now" rail uses large square key-art tiles. Block Puzzle and Hold'em are live; four "Coming soon" tiles (invented skill games: a word duel, a bubble shooter, a pool game, a trivia sprint) are dimmed and labelled. A "Play again" rail uses Chumba-style landscape tiles of your last Matches.
- **"Live now" strip:** a ticker of settled Matches ("Dana won 1,900 Gemas · Block Puzzle · 171–55").
- **"Back a Player" rail:** player cards with avatar, win rate and sample ("38 Matches · 61% won"), the requested entry, and an emerald **Offer** button.
- **Footer, like Skillz:** Players / Studios / Company columns, and the small "Simulated yield · 1 month = 10 min · devnet" line.

**Direction A, "Cut, lit":** the approved Cut system taken further. Near-black shell, chamfered everything, and faceted emerald light only on money surfaces. The richness comes from big lit game art and precise, premium typography (Schibsted Grotesk). Calm, expensive, fintech-grade.

**Direction B, "Treasure hall":** Chumba's density and energy without casino livery. Deep green-black depth, gem-facet textures behind the hero, larger and more saturated game tiles with badges ("Hot", "New"), a bolder hero, and more motion implied (light streaks, sparkle on gems). Still no red or gold.

**Direction C, "Arcade cut":** Skillz's playful game-first energy. Chunky chamfered tiles with a pressed 3D edge, bright game art, and a big friendly hero. Emerald is used as a solid material on key buttons and the balance. More toy-like and approachable.

**Prompt (fill in the direction line):**

> A desktop web app lobby for "Tesoro", a premium skill-gaming platform, painted as a crisp UI mockup at 1920×1200. **Direction: [A / B / C paragraph above].** Layout: [layout brief above]. Brand: near-black neutral shell `#0C0E10`, raised panels `#15181B`, off-white text, a single emerald accent (`#2DBE8C` / `#8FF5CF` / `#0B6B4E`) used only on the Gema balance, entry buttons and Offer/Play buttons, chamfered octagonal "emerald-cut" corners on every card, button and chip like reference 9, and a small faceted emerald gem as the currency mark. The game key art is vivid and lit and carries most of the colour. Real copy: "15,000" Gemas, entries 500 / 1,000 / 2,500, "Simulated yield · 1 month = 10 min" in small mono text. Page structure and rail rhythm closely follow reference 10 (Skillz: left sidebar, centred hero card, category chips, many square-tile rails with bold condensed headers), with the hero's cinematic drama from reference 11 (Chumba), but nothing copied; no casino red or gold, no neon, no logos. Sharp, legible UI, high fidelity, flat front-on screen, no device frame.

Self-check: the result reads as a desktop web app, not a phone. Games dominate. Emerald appears only on Gema and money actions. Corners are chamfered, not rounded. It has no casino look.

---

## Phase 1 result

**Picked: `lobby-desktop/take-1.png`, Direction A "Cut, lit"** (Ailton, Sep 30). It is reference 0 for everything below.

## Phase 1b: the Tesoro character, a treasure hunter

Ailton wants a character for the product: a **treasure hunter**, stylised "kinda chibi but not really". Explicitly **not a pirate**: no tricorn hat, no eyepatch, no sword, no gold coins, no treasure chest overflowing with gold. The character is an explorer who finds Gemas, not a looter.

Folder: `character/`. Attach reference 0 (take-1), so the rendering matches its lit, premium game-art quality.

**Design:**
- **Proportions:** stylised and semi-chibi. About 3.5–4 heads tall, with a slightly large head and expressive eyes, but real limbs and hands. Not super-deformed and not a baby.
- **Outfit:** field explorer. A short weathered jacket in deep teal or charcoal, rolled sleeves, a scarf, sturdy boots, and a canvas satchel with a few faceted emerald Gemas peeking out. On the belt: a brass-free, steel-and-emerald compass and a rolled map. A small lantern that glows emerald. A wide-brim explorer hat (not a tricorn) with an emerald-cut gem pin, or goggles pushed up on the forehead. Pick whichever reads better.
- **Palette:** the take-1 palette. Dark neutrals, off-white, emerald (`#2DBE8C`, `#8FF5CF`, `#0B6B4E`), one warm skin tone, and muted leather browns kept desaturated. No gold, no red, no yellow.
- **Rendering:** clean, lit, slightly 3D-painted like take-1's game art, not flat vector and not hand-inked. Readable at 96 px tall.
- **Gender and age:** a young adult, deliberately friendly and not tied to any real person. Offer two takes that vary the face and hair.

**Deliverables:**
1. `character/sheet-take-N.png` (2048×2048): a turnaround (front, three-quarter, back) plus a colour palette strip. Two takes.
2. After Ailton picks a take, `character/poses/<pose>.png` (1024×1024, transparent background, same character exactly):
   - `welcome`: waving, used on onboarding and an empty Lobby.
   - `explain`: pointing at something to the side, used on "how Gemas work" and Advance explainers.
   - `win`: holding a big glowing Gema over their head, used on the win screen.
   - `lose`: rueful shrug, dusting off the hat, used on the loss screen (kind, never mocking).
   - `waiting`: checking the compass, used on "waiting for an opponent" and cross-chain progress.
   - `empty`: peering through a spyglass at nothing, used on empty Backing and empty history.
   - `backing`: handing a Gema to someone off-frame, used on Backing and Offer screens.

Prompt for the sheet:

> A character design sheet for "Tesoro", a premium skill-gaming platform whose currency is faceted emerald gems called Gemas. The character is a friendly young treasure hunter and explorer, stylised semi-chibi (about 3.5 to 4 heads tall, slightly large head, expressive eyes, real hands and limbs, not super-deformed). Outfit: weathered short field jacket in deep teal or charcoal, scarf, sturdy boots, a canvas satchel with a few glowing faceted emerald gems peeking out, a steel-and-emerald compass and a rolled map on the belt, a small lantern with an emerald glow, and a wide-brim explorer hat with an emerald-cut gem pin (or goggles on the forehead). Explicitly NOT a pirate: no tricorn, no eyepatch, no sword, no gold coins, no gold treasure chest. Palette: dark neutrals, off-white, emerald `#2DBE8C` / `#8FF5CF` / `#0B6B4E`, desaturated leather browns, no gold, red or yellow. Rendering: clean, lit, slightly 3D-painted game art matching reference 0's quality. Front, three-quarter and back views on a plain dark `#0C0E10` background, plus a small palette strip. No text other than tiny view labels.

Self-check: nothing about it says pirate or casino. The Gema it carries matches the faceted emerald-cut gem mark. It still reads at small size.

### Phase 1b result (Ailton, Sep 30)

- **Both characters are kept, as a duo:** the man from `sheet-take-1.png` and the woman from `sheet-take-2.png`.
- **Proportions stay as drawn.** Not chibi; the current stylised proportions are approved.
- **One correction for him:** he must read clearly as an adult in his mid-20s, not a teenager. Give him a stronger jaw, a slightly older face, light stubble, and a little more height and shoulder breadth than her. Everything else is kept (outfit, hat pin, lantern, satchel, palette).
- **Roles, so each pose is drawn once rather than twice:**
  - **She is the guide and the Player.** Poses: `welcome`, `explain`, `win`, `lose`, `waiting`.
  - **He is the Backer and partner.** Poses: `backing` (handing her a Gema), `empty` (spyglass), `waiting-crosschain` (checking the compass while a Position crosses chains).
  - **Together:** `duo-hero` (both side by side, she holds up a glowing Gema, he has the map; for onboarding and the Lobby when signed out) and `duo-win` (they celebrate together; for a backed win).
- **Deliverables:**
  - `character/him-sheet-v2.png`, with the age correction.
  - The poses as `character/poses/<her|him|duo>-<pose>.png`, 1024×1024 (duo 2048×1024), on transparent backgrounds.

## Phase 1c: key art assets for code

The code needs clean art, not screenshots. Folder: `assets/`. Everything is based on take-1's art, with no UI text baked in.
- `block-puzzle-hero.png` (2400×1000): take-1's hero art (the glowing blocks on the dark board, with floating emerald gem blocks) with the left 40% kept dark and empty for the title and controls.
- `block-puzzle-tile.png` and `holdem-tile.png` (1024×1024, square key art as in take-1's Play Now row, no titles).
- `holdem-hero.png` (2400×1000): take-1's Hold'em slide art (white aces, blue chips, navy scene), left 40% dark and empty.
- `coming-soon-word-duel.png`, `coming-soon-bubble-burst.png`, `coming-soon-pocket-pool.png`, `coming-soon-trivia-sprint.png` (1024×1024, full colour; code dims them).
- `avatar-1..6.png` (512×512): stylised player avatars in take-1's style (for demo and seed data only), with varied people.

## Phase 2: every screen in the chosen direction

Attach take-1 as reference 0 for all of them, and keep its exact chrome (sidebar, top bar, type, clipped-corner style, emerald only on money). Once the character sheet is picked, attach it too, and put the character in the moments listed in Phase 1b (win, lose, waiting, empty, onboarding) as a supporting figure. The character never covers the game.

1. **`lobby-mobile/`** (1170×2532): the same Lobby on a phone. Top bar with balance, the hero card, the game tile rail (horizontal scroll), "Back a Player" cards, and a bottom navigation of Lobby / Play / Backing / Wallet.
2. **`game-block-puzzle-desktop/`**: the Block Puzzle game page before play.
   - Big key art header and rules ("Same Seed as your opponent · 90 s · higher score wins · pieces stay hidden until you press Start").
   - Entry picker, emerald **Play now** button, and "Challenge a friend" (copy link).
   - A "Your recent Matches" list with ✓ Won / ✕ Lost chips and Gema deltas.
   - A leaderboard of top scores today.
3. **`play-block-puzzle-desktop/`**: mid-run.
   - Centre: a large 8×8 board with coloured blocks and a few faceted emerald gem cells.
   - Big score and a 90-second countdown ring.
   - A tray of 3 upcoming pieces below.
   - Left panel: the Match card (entry 1,000, Pot 2,000, "Opponent plays the same Seed · waiting to be paired").
   - Right panel: combo and line-clear feedback.
   - Chrome dims so the board is the star.
4. **`play-holdem-desktop/`**: heads-up Hold'em table.
   - A stylised table in Tesoro's language: a dark surface with an emerald-cut rim, not green felt.
   - Opponent seat top, board of 5 community cards centre, your 2 hole cards bottom (face up to you only).
   - Chip stacks in plain numbers ("1,500 Chips"), since Chips are not Gemas; pot, blinds level "100/200 · Turbo" and a 30-second turn timer.
   - Action bar: Fold / Check / Call / Raise, with a bet slider and All-in.
   - A side panel with the hand log.
5. **`result-won-desktop/`**: a Match result celebration.
   - "✓ Won", "+900 Gemas" with the gem mark and a faceted light burst.
   - Scores 151 vs 42, and the breakdown: entry 1,000, fee 100.
   - Buttons: Play again, Lobby, Wallet.
6. **`wallet-desktop/`**: the Wallet.
   - Top: the big Gema balance, and the balance split as two panels, **Redeemable now 1,240** (emerald) and **Pending 3,760**, plus a "Pending by Source" list with progress meters and SOL/ETH/HYPE chips.
   - Positions grid: a card per Position showing chain, Principal, Debt, APY, Unlock Estimate, and a mini chart of Debt falling over time.
   - Actions: Take an Advance, Redeem, Unlock.
   - An "Open a Position" panel: choose chain (SOL / ETH / HYPE), amount, and a Horizon slider (1–12 months) showing Gemas issued and the Unlock Estimate.
7. **`wallet-crosschain-desktop/`**: opening an ETH Position. A 4-step progress tracker (Hoodi confirmed → LayerZero delivered → Position recorded → Gemas available), with the current step animated-looking and the future steps dim. Pending must never look like success.
8. **`backing-desktop/`**: the Backing marketplace.
   - Tabs: Requests / Public Offers / My Backings.
   - A grid of player cards: avatar, handle, game, "38 Matches · 61% won", requested entry and an emerald **Make an Offer** button.
   - A right drawer open on one player showing the Offer form: entry, "Player's share of the surplus" slider at 40%, and an outcome preview ("If they win: your 1,000 back first, then you keep 60% of the surplus. If they lose: you lose 1,000. They never owe anything").
9. **`wallet-mobile/`** and **`play-block-puzzle-mobile/`** (1170×2532): phone versions of 6 and 3.

Prompt template for each Phase 2 screen:

> A [desktop web app screen at 1920×1200 / phone screen at 1170×2532] for "Tesoro", in exactly the visual language of reference 0 (same navigation, chrome, typography, chamfered emerald-cut corners, emerald used only where Gemas move). Screen: [screen description above]. Real copy and numbers as given. Vivid game art where games appear; calm, premium chrome elsewhere. Sharp, legible UI mockup, flat front-on, no device frame, no logos, no casino red or gold.

## After Astra

Claude screenshots the chosen takes side by side with the running app, updates `DESIGN.md` (tokens, layout grid, components), and rebuilds the screens in `app/`: the desktop layout first, then responsive down to mobile.
