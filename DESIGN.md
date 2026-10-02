# Tesoro Design

**Direction: Cut, lit.** The game is the star; the platform is quiet, neutral chrome. Tesoro's signature is its *shape* — the emerald cut — and emerald appears only where Gemas move. The mockups are **style references** (look, components, hierarchy), not page layouts: they are vertical images and tuck everything together to fit. Layout and density follow the section "Layout and density" below. Reference 0 is the approved Lobby mockup `~/Work/gemstone-labs/tesoro/art-source/ui-redesign/lobby-desktop/take-1.png` (workspace, outside the repo) (1920×1200); structure follows Skillz (`attach/10-ref-skillz-desktop.jpg`), hero drama follows `attach/11-ref-chumba-desktop.jpg`. Original study: `~/Work/gemstone-labs/tesoro/docs/design/emerald-directions-study.html` (the "Cut" row).

Tesoro is a **desktop web app first** (sidebar, top bar, scrolling sections); phone and tablet are the same app collapsed, never a different product.

## Principles

- **Chrome stays out of the way.** Near-black neutral shell; game art supplies the colour. No atmosphere, glow, texture or ornament on platform surfaces.
- **Light from above.** Like a cut stone, every cut surface catches light on its top edge and chamfers and fades downward: outlines are vertical gradients (`--edge-1`, `--edge-2`, `--edge-em`) and raised fills are a touch brighter at the top (`--surface`, `--surface-2`). This is the only depth device: no drop shadows on chrome (`clip-path` clips them anyway), no glass.
- **The cut is the brand.** Chamfered (octagonal) corners on every card, chip, button, search box, balance pill, arrow button, avatar and tile — never rounded rectangles or pills. One corner size per component class, and the 1px outline follows the chamfer.
- **Emerald means Gemas move.** Emerald and faceted light (hard-stop gradients) are reserved for the balance pill, the chosen entry, redeemable amounts and money actions (Play now, Enter, Offer, Redeem). If it's emerald, Gemas move. Navigation, chips, arrows and Docs/Help are neutral.
- **Money is plain, big and honest.** Every balance separates *redeemable now* from *pending*, and pending shows its Sources (one row per Source: asset + Position). Simulated yield is labelled wherever amounts are shown, on-chain amounts included: the Wallet balance, every Position card, the Redeem and Return sheets, the ETH Opening summary and a won Match's pending line (`SimulatedYieldLabel`).
- **Green is not "success".** Because the accent is green, confirmations and wins always carry a second signal (icon or words), never colour alone.
- **Games dominate.** Key art is the only saturated colour on a page. Coming-soon games are dimmed and not clickable.

## Tokens

```css
:root {
  /* shell: near-black neutrals, sampled from take-1 */
  --shell: #090d0f;          /* page */
  --side: #0c1215;           /* sidebar, bottom nav, drawer */
  --raised: #11161a;         /* cards, chips, search */
  --raised-2: #171e25;       /* hover, active nav, ticker, menus */
  --line: rgba(234,239,236,.13); --line-2: rgba(234,239,236,.22);   /* real borders, rules */
  /* lit cut outlines (for --edge) and lit fills */
  --edge-1: linear-gradient(180deg, rgba(234,239,236,.24), rgba(234,239,236,.1) 32%, rgba(234,239,236,.06));  /* cards */
  --edge-2: linear-gradient(180deg, rgba(234,239,236,.4), rgba(234,239,236,.16) 36%, rgba(234,239,236,.1));   /* controls */
  --edge-em: linear-gradient(180deg, rgba(126,250,218,.85), rgba(45,190,140,.42) 40%, rgba(45,190,140,.24)); /* money */
  --surface: linear-gradient(180deg, #161d22, #11171b 44%, #0f1418);   /* raised fill */
  --surface-2: linear-gradient(180deg, #1d252c, #171e25 50%, #151b21); /* hover, active nav */
  --fg: #eaefec; --fg-2: rgba(234,239,236,.68); --fg-3: rgba(234,239,236,.40);
  /* emerald — money only */
  --em-hi: #6af8d6; --em: #24d8a8; --em-deep: #0a7d5c; --em-ink: #03201a;
  --facet: linear-gradient(160deg, #63f7d3 0%, #33e3b4 46%, #1fd3a2 46.5%, #0cbc8c 100%);
  /* money fills (buttons, chosen entry): lit from above, bright top rim, dark pavilion band at the base */
  --money-fill: linear-gradient(180deg, #5ef3cd 0%, #2fdcac 55%, #1cc699 100%);
  --money-rim: linear-gradient(180deg, rgba(225,255,246,.95), rgba(225,255,246,0) 55%);
  --money-base: rgba(3,32,26,.28);
  --money-off: linear-gradient(180deg, #15201d, #101816);
  --gem-ink-line: rgba(122,240,201,.5);
  /* semantic (never the accent) */
  --danger: #f2685a; --warn: #f2b94b;
  /* type */
  --f-body: "Schibsted Grotesk", "Hanken Grotesk", system-ui, sans-serif;
  --f-display: "Barlow Condensed", "Oswald", "Arial Narrow", Impact, sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, monospace;
  /* cut sizes */
  --cut-frame: 22px; --cut-card: 12px; --cut-btn: 7px; --cut-chip: 8px;
  --side-w: 244px;           /* 268px from 1440px up */
}
```

### The cut

```css
.cut { --c: var(--cut-card); --t: 1px; position: relative; clip-path: polygon(/* octagon by --c */); }
.cut::after { /* evenodd ring: the outline follows the chamfer */ background: var(--edge, var(--line)); }
```

`clip-path` clips real borders, so cut shapes draw their outline as an `::after` evenodd ring coloured by `--edge` (never `border`). Neutral cards use `--edge-1`, controls `--edge-2`, the balance pill and money panels `--edge-em`; money buttons and the chosen entry carry a crown highlight (a white-to-clear edge) plus an inset pavilion shade, and press down 1px. Inputs and selects cannot have pseudo-elements: their sides are an inset shadow and each chamfer a corner gradient (`--ring`, `--t`). Classes: `cut-frame` (heroes, sheets), `cut-card` (cards, nav items, chips-as-buttons, tiles), `cut-btn` (buttons, avatars), `cut-chip` (small chips, entry buttons, ticker). Focus never uses `outline` on a cut shape (the clip turns it into a broken rectangle): the edge itself becomes the ring, 2px solid `--fg`, following the chamfers. Light fills (money buttons, the chosen entry, the white Hold'em action, the active Wallet tab) take an ink ring set 3px inside instead. A cut wrapper around a bare input, select or summary takes the ring for it; a cut ancestor further up never lights.

## Type

- **Display**: Barlow Condensed 800, all caps, for section headers (PLAY NOW, PLAY AGAIN, BACK A PLAYER), page titles (`.h-section`, `.page-title`) and **game titles wherever a Game is presented as a poster**: the Lobby hero, Play now tiles and the game page hero. Also playing-card ranks and leaderboard ranks. List rows (Play again, Match history) keep Schibsted.
- **UI text and figures**: Schibsted Grotesk (weights 400/700/800/900), including hero titles, buttons and every amount. `tabular-nums` on amounts in lists and tables (`.tnum`); big display figures (balance pill, sidebar panels, entry amounts) use proportional figures.
- **Verifiable data**: IBM Plex Mono only: chain chips, hashes, Seeds, timers, footer links, the simulated-yield label.

Heavy Schibsted (800–900) gets `word-spacing: .14em` (Barlow does not need it).

## Logo

The Tesoro logo is the **T-gem**: an emerald-cut octagon whose facets form a "T" (approved take 2), with the wordmark "Tesoro" (Schibsted Grotesk 800, outlined). Vectors are generated by `app/scripts/build-brand.mjs` into `app/public/brand/`; the React components are `TesoroMark` (`variant="full|mono|simple"`, `tone="dark|light"`) and `TesoroLogo` in `components/brand`. Marketing copies live in `~/Work/gemstone-labs/tesoro/art-source/ui-redesign/brand/export/`.

- **Variants.** `full` (faceted, 48 px and up), `simple` (octagon + bold T, under 48 px), `mono` (currentColor, three opacity tiers). Lockups: horizontal (sidebar, mobile header, footer) and stacked, each in a dark-background version (off-white #F5F3EE wordmark) and a light-background version (#0C0E10 wordmark, deeper emerald). Never use one on the other's background.
- **Clear space** = twice the T's stem width on every side (about 35% of the mark's height).
- **Minimum sizes.** Full mark 48 px, simple mark 16 px, horizontal lockup 120 px wide, stacked lockup 72 px wide.
- **Never recolour**, restyle, stretch, rotate, add effects, or retype the wordmark.
- **T-gem = brand; faceted Gema gem = currency.** Never use the T-gem for currency (balance pill, entry chips, amounts) and never use the plain gem as the logo.
- Contrast (checked): the wordmark is 17.4:1 on both backgrounds; the mid emerald is 7.6:1 on #0C0E10, and the deeper light-version emerald 3.0 to 3.7:1 on #F5F3EE. The lightest highlight facets on the light version are about 2:1 and are decoration only.
- **Site and app icons = the T-gem art, not the vector** (founder, Oct 2). From `art-source/ui-redesign/brand/`: `mark-take-2.png` (transparent) for `favicon.ico` (16/32/48), `icon.png` (192) and the maskable 512 (centred on #0C0E10 in the safe zone); `app-icon.png` (glowing tile) for `apple-icon.png` (180) and the `manifest.ts` 192/512 icons.
- Also generated by `build-brand.mjs`: `opengraph-image.png` and `twitter-image.png` (1200×630).

## Money art: the facet crown

`public/brand/facet-crown.svg` (generated by `app/scripts/build-facet-crown.mjs`) is an emerald step cut seen from above, its top facets brightest. It sits low in the Wallet balance panel (`.facet-panel`), showing only its lit upper facets, clear of every figure. Money surfaces only.

## The Gema mark

A small emerald-cut stone (octagon with table facet and facet lines, emerald gradient) — never a flat ◆ glyph, never gold. It precedes Gema amounts of consequence (balance pill, entry chips); it is **not** the logo (see Logo). A brief glint animation is allowed on the balance only, and is off under `prefers-reduced-motion`. On a money fill (money button, chosen entry) the full-colour mark blends in, so it is drawn in **ink**: body in the text colour (`--em-ink`), table and facet lines in `--gem-ink-line`. Disabled money buttons keep the full-colour mark.

## Shell and layout

- **Desktop (≥1024px):** fixed left sidebar (`--side-w`), then a sticky top bar over the content.
  - Sidebar is navigation only, top to bottom: wordmark with gem, Lobby / Play / Backing / Wallet (active item raised and outlined), divider, Docs (not built yet: shown dimmed, not clickable) / Help (`/help`: a four-step Start here, topic jump chips, then one collapsible `<details>` per question, grouped by topic; static, no account needed). No Positions card, no chips: balances live in the top bar pill and the Wallet. The corner guide, when it has a tip, sits at the sidebar's bottom.
  - Top bar: the Gema balance pill (emerald, links to Wallet) and the Account avatar menu (Account, Wallet, Sign out); signed out: a Sign in button. The search box shows on the Lobby only and filters its games.
  - Content is one centred column, max 1320px, with 32px side padding; wider screens get margins, not more content. The footer is one line ("Fair play · on-chain", the simulated-yield label) plus links.
- **Below 1024px:** the sidebar becomes a left drawer (menu button in the top bar), a four-item bottom navigation appears, the search box drops to its own row on the Lobby, and grids collapse to one column.
- **Lobby order:** hero carousel (one big slide, slide markers inside its bottom edge, next arrow, auto-advance that pauses on hover, focus and a Pause button, and stops under `prefers-reduced-motion`) → **Live wins** (a slow strip of recent settled wins from devnet, linking to each Match; pauses on hover and focus; a plain scrollable row under reduced motion) → Continue (only with Matches in progress) → Play now (category filter chips above; the two live Games as large tiles; Coming soon as one quiet strip) → Play again (only with settled Matches, max 3) → Back a player (max 3 Requests, "See all") → footer. The settled-Matches ticker is not in the Lobby.
- **Sections:** a bold condensed header, an optional "See all →" link, then a calm grid (no scroll arrows, no horizontal rails).

## Components

Live in `app/src/components/ui` (primitives, money, inputs, icons, `ui.css`), the shell in `components/shell`, Lobby pieces in `components/lobby`. `/design` renders every ui component and state.

- **Button** — `money` (polished table: `--money-fill` with the `--money-rim` edge and a 3px `--money-base` band; `lg` cuts 9px) only where Gemas move; `neutral` otherwise; sizes `sm`, `md`, `lg` (Play now).
- **Icon button** (`.icon-btn`) — square cut button for arrows, menu, close, copy.
- **Entry picker** — 500 / 1,000 / 2,500; the chosen entry is filled with `--money-fill` and carries the ink Gema mark. An entry the balance cannot cover is dimmed (never struck through).
- **Skeleton** (`SkeletonCards`) — loading is shaped like the cards that are coming (cut cards with a faint sweep), with the old status line kept for screen readers. Used for Requests, Positions and Match history.
- **Living surfaces** (founder, Oct 2: "too static") — the hero art settles in (slow zoom) and its copy rises in order on each slide; a few sparkles twinkle over the art; the big money action catches a passing light every few seconds; Play now tiles lean toward the pointer with a moving glare and carry a live Queue badge; balances count up to new values (`CountUp`), and a won amount counts up from zero; the Block Puzzle score pops on change; grids rise in as they scroll into view (scroll-driven, no JS); each page arrives with a short rise. The red pulsing dot means *live* and always sits beside the word.
- **Motion that answers an action** — sheets rise in over a blurred page, the drawer and the Offer drawer slide from where they dock, the Account menu drops in, the top bar frosts once the page scrolls under it, and the Lobby hero's slide markers fill while auto-advance runs. All off under `prefers-reduced-motion`.
- **Tile** — Play Now key art with a bottom label; coming-soon variant dimmed with a "Coming soon" chip.
- **Player card** — avatar, name, Game, "N Matches · X% won", Entry, emerald **Offer**. The avatar and name lead to the Player's Account (`AccountLink`), as a Player's key does wherever one is shown: Requests, applicants, Top scores today, both Players of a Match someone else is viewing, the backed Player on a Backing split, Hold'em seats once the Match has ended. A Backer's key stays plain text.
- **Ticker**, **Balance pill**, **Category chip**, **Search**, **Account menu** — see the shell and Lobby.
- Icons: neutral `lucide-react` line icons (1.7–1.8 stroke) in the shell; the original square-cap glyphs in `ui/icons.tsx` remain for status marks (check, cross, clock).

## Art

All game art, hero art and avatars come from one map, `app/src/lib/art.ts`. Until the final assets land (`~/Work/gemstone-labs/tesoro/art-source/ui-redesign/assets/`), they are **placeholder crops of take-1** produced by `app/scripts/crop-placeholder-art.mjs` into `app/public/art/placeholder/`; swapping to final art is one line per image. Hero art keeps its left 40% dark for the title. Art carries no UI text (titles, chips and prices are real text). The Trading Duel hero and tile are generated placeholders until Astra's art is imported with `import-final-art.mjs`.

## Implementation decisions

- `--fg-3` (40%) fails AA for text: decoration only; all text uses `--fg` or `--fg-2`.
- Only Gema actions (Play now, Enter, Offer, Redeem, Take an Advance, sliders that set Gema amounts) and the balance are emerald.
- Money buttons use `--em-ink` for text and the inset focus ring.
- Match results always pair an icon with words: ✓ Won · ✕ Lost · − Draw / Refunded (Play Again tiles too).
- Simulated Unlock Estimates show an absolute time (the yield clock runs 1 month = 10 min); "–" until one exists.
- Names are not on chain: Players show as short keys with a stable avatar (`avatarFor`), one of twelve animal heads cut from gemstones. Avatars never show people, and never a green stone or a loose gem (emerald and the gem mark belong to Gemas).
- Dev only: `?dev=out` previews the signed-out UI and `?dev=demo` a populated fake Account (with `NEXT_PUBLIC_DEV_WALLET=1`); used for screenshots in `app/docs/screens/redesign-*.png`.

## Characters and the three product screens (p2)

Approved mockups: `art-source/ui-redesign/{result-won,wallet,backing}-desktop/take-1.png`. Screenshots and side-by-side comparisons are in `app/docs/screens/p2-*.png` (`app/scripts/screenshot-p2.mjs`, `compare-p2.mjs`).

**Character placement rule (founder, Sep 30: "too much in the design").** him = the Player / guide, her = the Backer. Characters are decorative (empty alt), never carry information and never overlap text or controls. **Only torso-up crops exist in the app** (`art.busts`, generated by `app/scripts/make-busts.mjs` into `public/art/final/characters/bust/`, and the larger `art.guide` crops from `app/scripts/make-guide-busts.mjs` for the Guide overlay; the full-body poses are source art and are never rendered). There are exactly three ways a character appears:

1. **Bust card** (`<BustCard>`, `components/ui/Character.tsx`): a bust flush to the bottom edge of an explainer, tip or empty-state card.
2. **Guide overlay** (`<GuideProvider>`, `<GuideOverlay>`, `useGuideTip`, `components/guide`): the first time a contextual tip applies, the page darkens and the character rises in large at the bottom right, torso up and fading out below the waist (mirrored where needed so the gesture faces the bubble), then a speech bubble with the tip and a "Got it" action pops in beside it, its tail pointing at the character (above it on phones). It stays until "Got it" (or the tip's link, or Escape); focus sits on "Got it" and returns afterwards. One at a time, dismissal remembered per tip id in localStorage, so each tip shows once. Hidden while a game is running (`useGuideHidden`).
3. **Moment overlay** (`MomentOverlay`, `components/match`): the win and backed-win celebration, bust plus the Gema burst over the result for about 3 s or until clicked (or Escape / Enter; focus sits on its Continue button and returns afterwards), once per Match per tab, counted only once it has shown. The result screen underneath has no character.

Never full-body inside a page layout, and never during play: no character in the Block Puzzle or Hold'em screens, on desktop or mobile.

| Where | Character |
|---|---|
| Match result, Player won | overlay: `him-win` bust |
| Match result, Backer, backed win | overlay: `duo-win` crop |
| Match result, Lost / Draw / Refunded | none |
| Wallet, Positions | bust card "How Gemas work": `him-explain` (with no Positions: the bust in the empty card) |
| Wallet, first visit | guide tip: `him-explain` ("Pending is not lost") |
| Wallet, Opening an ETH Position | guide tip: `her-waiting-crosschain` ("LayerZero usually takes 2–5 minutes") |
| Lobby, first visit | guide tip: `him-welcome` |
| Backing, first visit | guide tip: `her-backing` ("What Backing means") |
| Backing, empty states | bust card: `her-empty` |
| Game page (`/play/<game>`) | bust card "How to play": `him-explain` |
| Account (`/account/<key>`), no Matches yet | the bust in the empty card: `him-waiting` |

**Match result.** One focused card (max 760px): game and rule line, outcome, amount, scores, entry and fee; the actions sit under it, nothing else competes. Won shows the faceted emerald burst behind "+N Gemas" and always the line "Pending · redeemable as their yield lands" linking to the Wallet: won Gemas are claims on the loser's Source, never cash in hand. Loss is neutral-white with a danger icon; no burst. Backed Matches show the split (BackingSplit); the backed Player is told they never owe anything. Hold'em shows a Chips-free result (Won / Lost tiles).

**Wallet.** `wl-*` classes. One balance hero (`.facet-panel`, money only): Total Balance big, Redeemable now (with the Redeem action) and Pending as two secondary figures, Pending by Source behind a toggle. "Open a Position" is a header button that opens a sheet (chain tabs, Amount, Horizon, Gemas issued and Unlock Estimate from the real quote). Positions are a grid of cards showing only Principal, Debt and Unlock Estimate; APY and the Debt chart (a projection from the live yield rate, labelled projected) sit behind "Details". Only chains with a Position get a card; HYPE is a muted line ("coming soon"). The "How Gemas work" bust card appears once, beside the Positions (below them under 1180px). With no Positions, one full-width card replaces both the list and the explainer: "No Positions yet", the Open a Position action, and how Gemas work as three numbered steps, with the `him-explain` bust flush to its bottom edge. Copy rule: "Your Principal is never played", never "protected".

**Game page, play screens, cross-chain tracker (p2b).** Mockups `{game-block-puzzle,play-block-puzzle,play-holdem,wallet-crosschain}-desktop/take-1.png`; screenshots `app/docs/screens/p2b-*.png` and `p2b-compare-*.png` (`app/scripts/screenshot-p2b.mjs`).
- `/play/<game>` (`block-puzzle`, `holdem`) is the Game's detail page, linked from the Lobby tile: a hero with the entry picker, Play now, Challenge a friend (and Practice for Block Puzzle); below it two sections only: Recent Matches (the last 3, "See all" → `/matches?game=<game>`; Top scores today inside it when Block Puzzle has winners from the last 24 h on chain, or a one-line error when the read fails) and the How to play bust card. `/play` is the game picker.
- Block Puzzle play: the board is the centre. A slim bar above it carries the score, the 90 s ring, Combo ×n and Lines, and Entry · Pot; the opponent status and Seed sit in one line under the tray. No Recent list during play (the last clears show on the game-over card). Practice (`/play/practice`) is the same screen with nothing staked.
- Block Puzzle blocks are cut jewels like the key art: a table facet with four bevels lit from above (mitred borders in `color-mix` tints of the block colour, width scaled to the board by container units). Empty cells are shallow wells. The landing preview shows the held piece's colour; an invalid spot shows danger red. Gem cells stay the emerald octagon.
- Hold'em cards: paper faces with condensed ranks; the back (`public/art/card-back.svg`) is navy with a steel lattice and the T-gem in steel — never emerald. The felt has a soft centre light; the pot is a cut plaque.
- Trading Duel (`app/src/games/trading-duel`): direction is never green or red (green is Gemas, red is casino and danger). **Sapphire** is up / long (`--up`, `#5aa2ff`) and **amber** is down / short (`--down`, `#f2a63b`), on the chart, the position card, the Long / Short buttons and the fill log, always with the words as a second signal. Emerald appears only where Gemas move (entry, payout). The key art `trading-duel-{hero,tile}.webp` is a generated placeholder (`app/scripts/make-trading-duel-placeholder.mjs`: sapphire and amber candles cut like stones, one emerald Gema) until Astra's art from `TRADING-DUEL-ART-BRIEF.md` is imported with `import-final-art.mjs`. The asset picker (`AssetPicker`, SOL / ETH / HYPE) is neutral: the chosen asset is a pale chip.
- Hold'em play: a slim header (title, blinds, hand #, entry, turn clock), the octagonal navy table with a steel rim centred and large (no green felt), the action bar (Fold, Check, Call, Raise, Raise to, slider, presets, All-in), and the Hand log in a collapsed drawer (inferred by this client from table reads; a poll can merge two actions, and it says so).
- `/matches` (All Matches, the Account's Match history): every finished Match it played or backed, both games, newest first, 20 per page, game tabs All / Block Puzzle / Hold'em in the URL. Rows pair the result icon with its word; a backed Player's loss is "Lost · 0 Gemas" with the Backer named ("Backer … bore the loss"), as in BackingSplit. Lobby Play again and the game pages link here.
- `/account/<key>` (a Player's Account, as anyone may see it; signed out too): only what the Player played. **Hero** (a cut frame): the avatar, the short key as the title, the full key in mono, and one line of facts (playing since, last Match, the games played); Challenge and Copy link sit in it, and under a rule one note: on your own Account that this is how others see you (with links to the Wallet and All Matches), on someone else's with no live Request that they are not asking to be backed. **Asking to be backed**: a strip with one row per live Request and the page's only emerald action, Make an Offer, which opens the Offer drawer on `/backing#<request>`. **Scoreboard**: Gemas won and lost lead in a wide panel (the net as the big figure, won and lost under it, after Fees) with the running total inside it; beside it Matches ("W of N won" with a neutral bar, the record per game, the best Block Puzzle score, draws and refunds stated as not counted) and Backings ("W of N won", the Backers' Gemas, their net and how many are ahead). The Player's Gemas and the Backers' always sit side by side: a loss under a Backing costs the Player nothing, so one figure without the other flatters. Running total: one neutral step line around a zero baseline, a step per Match in the order the Matches were opened (the id carries the opening time, not the settlement); no emerald or red series, the sign is in the text; pointer and arrow keys read each Match; hidden under two Matches with a winner. A win rate bar is neutral too: emerald is for Gemas. **Challenge** is a sheet with Game and entry that says plainly the link is the only way the Challenge reaches them. **Match history** as on `/matches`, but a row is two links side by side instead of one: the opponent leads to their Account and the chevron opens the Match (anyone can view a Match). A backed row carries the Backer's result ("Backed by … · Backer +540", "Backer … bore the loss · −1,000"). **No Matches yet**: one card replaces the scoreboard and the history, with the `him-waiting` bust flush to its edge, what the Account will show (Matches, Gemas won and lost, Backings), and on your own Account the way to start: Play now, or Open a Position when you hold no Gemas. Your own Account page opens even before the Account exists on chain. No balances, no Positions, nothing the Account did as a Backer. The key in the URL is the Account key; a wallet address is sent on to its Account. Screenshots `app/docs/screens/account-*.png` (`app/scripts/screenshot-account.mjs`).
- `/wallet/opening`: OPENING YOUR ETH POSITION, four steps (Hoodi confirmed, LayerZero delivered, Position recorded, Gemas available). Only the last step means Gemas exist; pending never shows a check. Shown right after "Open an ETH Position": the four-step tracker plus one summary line and one note; the corner guide explains the wait. The Wallet's in-page trackers remain.
- Dev only: `/design/play` (Block Puzzle Match screen, local Seed) and `/design/table` (Hold'em table on a fixed hand, `?facing=1`).

**Backing.** Page header with a "Post a Request" button (opens a sheet) and tabs Requests / Public Offers / My Backings with one Sort select. Request cards sit in a calm grid (avatar, handle, game, "N Matches · X% won", Requested entry, Make an Offer); no game art strip. The MAKE AN OFFER drawer opens on demand over the page from the right (a bottom sheet below 1024px). Banners show only when actionable (a funded Backing, an Offer for you, an error or confirmation).

## Layout and density

The founder's rule (Oct 1): the website must not copy the mockups' density. Mockups are vertical images that tuck everything together; the app scrolls.

- **Pages scroll, without dead bands.** Do not fit everything into one viewport, but do not leave empty rows either (founder, Oct 2: "too much empty space"). Each section has one job, with `--section-gap` 36px (52px from 1024px) between sections and a capped, centred column (max 1320px); 1920px screens get margins, not more stuff. Wide screens put an explainer beside its list rather than under it (Wallet: Positions | How Gemas work).
- **One primary action per screen**, obvious. Secondary information goes behind progressive disclosure: `<details>` toggles ("Details", "Pending by Source", the Hand log), hover and tooltips, and sheets or drawers that open on demand (Open a Position, Post a Request, Make an Offer, Redeem).
- **Fewer simultaneous panels**, fewer labels and meta lines, fewer type sizes, more line-height. A number appears once per screen.
- **Global chrome is minimal**: the sidebar is navigation only, the top bar holds the balance pill and the Account (search on the Lobby only), the footer is one line plus links. Category chips belong to the Lobby's Play now section only.
- **Play screens** centre the game (board or table) with a slim bar above; side columns do not exist. Info that is not needed mid-play moves to the result.
- **Mobile (390px)** applies the same simplifications; secondary content goes in sheets; nothing crowds horizontally.
- Premium pass (Oct 2): before/after in `app/docs/screens/premium-*.png`.
- Screenshots for this pass: `app/docs/screens/declutter-*-before.png` and `-after.png` (`app/scripts/screenshot-declutter.mjs`); live proof by `app/scripts/live-declutter.mjs`.

Dev only: `/design/result?case=won|lost|draw|refunded|backed-player|backed-lost|backer-won|backer-lost|holdem-won|holdem-lost` renders every result variant from fixtures (`NEXT_PUBLIC_DEV_WALLET=1`).

## Landing page (`/`)

Plan, copy and decisions: `~/Work/gemstone-labs/tesoro/art-source/landing/PLAN.md` (workspace); Astra brief: `PROMPTS.md` beside it. Code: `app/src/app/(marketing)/page.tsx`, `app/src/components/landing`. The landing is `/` (`/welcome` redirects there) and the Lobby is `/lobby`. The app routes live in the `(app)` route group, so the landing loads none of Privy, chain data or the shell.

- **Written for mainnet.** Testnet-only content (the Multichain status line, the footer's "testnet / devnet · no real value") renders only while `NEXT_PUBLIC_LAUNCH_STAGE` is not `mainnet`. Launch app and every in-app link read `NEXT_PUBLIC_APP_URL` (the landing page and the app get separate URLs at launch).
- **Light theme, landing only.** `:root[data-theme="light"]` in `landing.css`: `--shell #f5f3ee` (the background the light lockup was checked on), `--fg #111816`, `--fg-2 #4a5451`, `--em #086b4f` (5.8:1), `--facet` deep emerald with white ink. Set before paint from localStorage, else `prefers-color-scheme`; cleared when leaving the page so the app stays dark. The hero is the dark cave in both themes (the light theme starts below it); the final CTA becomes a cut-frame window in light.
- **Nav.** Over the hero it always uses dark tokens, with a top scrim on the art and the links on a frosted cut group; once scrolled it takes the theme's surface.
- **Sections.** How it works is a five-node diagram (a pulse runs along it, a return arc reads "Yield repays the Debt"); Gemas centres the upright 3D Gema on an octagonal plinth inside stepped octagon outlines with the three points as callouts (pinned on desktop, one highlighted per scroll beat); Your Principal is a Position drawn as a vault (yield rises into the Debt meter, the clasp opens at zero); Backing is a live Offer card (entry, Player's share, outcome bars, no Fee figures); Multichain is a 3D scene (three raw crystals stream into one cut ledger); Built for studios is a bento (catalogue with a "Your game" slot, the Pot split as illustrative proportions, Players arriving with Gemas).
- **Characters (marketing exception to the placement rule).** Three moments, never two in view: `him-guide` small beside the How it works heading, `her-backer` beside the Offer card, and the full-figure duo climbing the rope in the final CTA. No character in the hero. Busts-only still holds inside the app.
- **Motion.** GSAP ScrollTrigger + Lenis, loaded only here, desktop-only for smooth scroll, the Gemas pin and the hero parallax; nothing under `prefers-reduced-motion`. The server HTML is the complete page. The hero lantern glows and flickers (CSS, positioned to follow the art's object-fit).
- **3D** (`components/landing/{gem,chains}`, `Stage3D`): the procedural emerald cut (`emeraldCut.ts`, tested) with drei's refraction material over a procedural studio environment. Live only on ≥1024 px with WebGL, motion allowed and 4+ cores; otherwise a poster rendered from the same scene (`scripts/render-landing-posters.mjs`). Always the plain Gema, never the T-gem. `public/art/landing/gema.glb` is the same mesh for Blender (`scripts/export-gem-glb.mjs`).
- **Art pipeline.** `scripts/import-landing-art.mjs` (Astra's chosen takes → AVIF/WebP per width, `art.generated.ts`). Gameplay loops: `scripts/capture-landing-loops.mjs`; screenshots `scripts/screenshot-landing.mjs` → `app/docs/screens/landing-*.png`; scroll recording `scripts/record-landing-scroll.mjs`.
