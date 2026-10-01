# Tesoro Design

**Direction: Cut, lit.** The game is the star; the platform is quiet, neutral chrome. Tesoro's signature is its *shape* — the emerald cut — and emerald appears only where Gemas move. The mockups are **style references** (look, components, hierarchy), not page layouts: they are vertical images and tuck everything together to fit. Layout and density follow the section "Layout and density" below. Reference 0 is the approved Lobby mockup `~/Work/gemstone-labs/tesoro/art-source/ui-redesign/lobby-desktop/take-1.png` (workspace, outside the repo) (1920×1200); structure follows Skillz (`attach/10-ref-skillz-desktop.jpg`), hero drama follows `attach/11-ref-chumba-desktop.jpg`. Original study: `~/Work/gemstone-labs/tesoro/docs/design/emerald-directions-study.html` (the "Cut" row).

Tesoro is a **desktop web app first** (sidebar, top bar, scrolling sections); phone and tablet are the same app collapsed, never a different product.

## Principles

- **Chrome stays out of the way.** Near-black neutral shell; game art supplies the colour. No atmosphere, glow, texture or ornament on platform surfaces.
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
  --line: rgba(234,239,236,.13); --line-2: rgba(234,239,236,.22);
  --fg: #eaefec; --fg-2: rgba(234,239,236,.68); --fg-3: rgba(234,239,236,.40);
  /* emerald — money only */
  --em-hi: #6af8d6; --em: #24d8a8; --em-deep: #0a7d5c; --em-ink: #03201a;
  --facet: linear-gradient(160deg, #63f7d3 0%, #33e3b4 46%, #1fd3a2 46.5%, #0cbc8c 100%);
  /* semantic (never the accent) */
  --danger: #f2685a; --warn: #f2b94b;
  /* type */
  --f-body: "Schibsted Grotesk", "Hanken Grotesk", system-ui, sans-serif;
  --f-display: "Barlow Condensed", "Oswald", "Arial Narrow", Impact, sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, monospace;
  /* cut sizes */
  --cut-frame: 22px; --cut-card: 12px; --cut-btn: 10px; --cut-chip: 8px;
  --side-w: 244px;           /* 268px from 1440px up */
}
```

### The cut

```css
.cut { --c: var(--cut-card); --t: 1px; position: relative; clip-path: polygon(/* octagon by --c */); }
.cut::after { /* evenodd ring: the outline follows the chamfer */ background: var(--edge, var(--line)); }
```

`clip-path` clips real borders, so cut shapes draw their outline as an `::after` evenodd ring coloured by `--edge` (never `border`). Neutral cards use `--line`, controls `--line-2`, the balance pill a translucent emerald, money surfaces `transparent`. Inputs keep a real border (they cannot have pseudo-elements). Classes: `cut-frame` (heroes, sheets), `cut-card` (cards, nav items, chips-as-buttons, tiles), `cut-btn` (buttons, avatars), `cut-chip` (small chips, entry buttons, ticker). Focus rings sit inside the shape (`outline-offset: -4px`).

## Type

- **Display**: Barlow Condensed 800, all caps, for section headers (PLAY NOW, PLAY AGAIN, BACK A PLAYER) and page titles: `.h-section` (about 48px at 1920, fluid from 30px), `.page-title`. Nothing else uses it.
- **UI text and figures**: Schibsted Grotesk (weights 400/700/800/900), including hero titles, buttons and every amount. `tabular-nums` on amounts in lists and tables (`.tnum`); big display figures (balance pill, sidebar panels, entry amounts) use proportional figures.
- **Verifiable data**: IBM Plex Mono only: chain chips, hashes, Seeds, timers, footer links, the simulated-yield label.

Heavy Schibsted (800–900) gets `word-spacing: .14em` (Barlow does not need it).

## Logo

The Tesoro logo is the **T-gem**: an emerald-cut octagon whose facets form a "T" (approved take 2), with the wordmark "Tesoro" (Schibsted Grotesk 800, outlined). Vectors are generated by `app/scripts/build-brand.mjs` into `app/public/brand/`; the React components are `TesoroMark` (`variant="full|mono|simple"`, `tone="dark|light"`) and `TesoroLogo` in `components/brand`. Marketing copies live in `~/Work/gemstone-labs/tesoro/art-source/ui-redesign/brand/export/`.

- **Variants.** `full` (faceted, 48 px and up), `simple` (octagon + bold T, under 48 px: favicon `icon.svg`, `favicon.ico`), `mono` (currentColor, three opacity tiers). Lockups: horizontal (sidebar, mobile header, footer) and stacked, each in a dark-background version (off-white #F5F3EE wordmark) and a light-background version (#0C0E10 wordmark, deeper emerald). Never use one on the other's background.
- **Clear space** = twice the T's stem width on every side (about 35% of the mark's height).
- **Minimum sizes.** Full mark 48 px, simple mark 16 px, horizontal lockup 120 px wide, stacked lockup 72 px wide.
- **Never recolour**, restyle, stretch, rotate, add effects, or retype the wordmark.
- **T-gem = brand; faceted Gema gem = currency.** Never use the T-gem for currency (balance pill, entry chips, amounts) and never use the plain gem as the logo.
- Contrast (checked): the wordmark is 17.4:1 on both backgrounds; the mid emerald is 7.6:1 on #0C0E10, and the deeper light-version emerald 3.0 to 3.7:1 on #F5F3EE. The lightest highlight facets on the light version are about 2:1 and are decoration only.
- Also generated: `apple-icon.png` (180), `manifest.ts` icons (192, 512, 512 maskable: simple mark centred on #0C0E10), `opengraph-image.png` and `twitter-image.png` (1200×630).

## The Gema mark

A small emerald-cut stone (octagon with table facet and facet lines, emerald gradient) — never a flat ◆ glyph, never gold. It precedes Gema amounts of consequence (balance pill, entry chips); it is **not** the logo (see Logo). A brief glint animation is allowed on the balance only, and is off under `prefers-reduced-motion`.

## Shell and layout

- **Desktop (≥1024px):** fixed left sidebar (`--side-w`), then a sticky top bar over the content.
  - Sidebar is navigation only, top to bottom: wordmark with gem, Lobby / Play / Backing / Wallet (active item raised and outlined), divider, Docs / Help (not built yet: shown dimmed, not clickable). No Positions card, no chips: balances live in the top bar pill and the Wallet. The corner guide, when it has a tip, sits at the sidebar's bottom.
  - Top bar: the Gema balance pill (emerald, links to Wallet) and the Account avatar menu (Account, Wallet, Sign out); signed out: a Sign in button. The search box shows on the Lobby only and filters its games.
  - Content is one centred column, max 1320px, with 32px side padding; wider screens get margins, not more content. The footer is one line ("Fair play · on-chain", the simulated-yield label) plus links.
- **Below 1024px:** the sidebar becomes a left drawer (menu button in the top bar), a four-item bottom navigation appears, the search box drops to its own row on the Lobby, and grids collapse to one column.
- **Lobby order:** hero carousel (one big slide, dots, next arrow, auto-advance that pauses on hover, focus and a Pause button, and stops under `prefers-reduced-motion`) → Continue (only with Matches in progress) → Play now (category filter chips above; the two live Games as large tiles; Coming soon as one quiet strip) → Play again (only with settled Matches, max 3) → Back a player (max 3 Requests, "See all") → footer. The settled-Matches ticker is not in the Lobby.
- **Sections:** a bold condensed header, an optional "See all →" link, then a calm grid (no scroll arrows, no horizontal rails).

## Components

Live in `app/src/components/ui` (primitives, money, inputs, icons, `ui.css`), the shell in `components/shell`, Lobby pieces in `components/lobby`. `/design` renders every ui component and state.

- **Button** — `money` (facet gradient) only where Gemas move; `neutral` otherwise; sizes `sm`, `md`, `lg` (Play now).
- **Icon button** (`.icon-btn`) — square cut button for arrows, menu, close, copy.
- **Entry picker** — 500 / 1,000 / 2,500; the chosen entry is facet-filled with the Gema mark.
- **Tile** — Play Now key art with a bottom label; coming-soon variant dimmed with a "Coming soon" chip.
- **Player card** — avatar, name, Game, "N Matches · X% won", Entry, emerald **Offer**.
- **Ticker**, **Balance pill**, **Category chip**, **Search**, **Account menu** — see the shell and Lobby.
- Icons: neutral `lucide-react` line icons (1.7–1.8 stroke) in the shell; the original square-cap glyphs in `ui/icons.tsx` remain for status marks (check, cross, clock).

## Art

All game art, hero art and avatars come from one map, `app/src/lib/art.ts`. Until the final assets land (`~/Work/gemstone-labs/tesoro/art-source/ui-redesign/assets/`), they are **placeholder crops of take-1** produced by `app/scripts/crop-placeholder-art.mjs` into `app/public/art/placeholder/`; swapping to final art is one line per image. Hero art keeps its left 40% dark for the title. Art carries no UI text (titles, chips and prices are real text).

## Implementation decisions

- `--fg-3` (40%) fails AA for text: decoration only; all text uses `--fg` or `--fg-2`.
- Only Gema actions (Play now, Enter, Offer, Redeem, Take an Advance, sliders that set Gema amounts) and the balance are emerald.
- Money buttons use `--em-ink` for text and focus rings.
- Match results always pair an icon with words: ✓ Won · ✕ Lost · − Draw / Refunded (Play Again tiles too).
- Simulated Unlock Estimates show an absolute time (the yield clock runs 1 month = 10 min); "–" until one exists.
- Names are not on chain: Players show as short keys with a stable placeholder avatar (`avatarFor`).
- Dev only: `?dev=out` previews the signed-out UI and `?dev=demo` a populated fake Account (with `NEXT_PUBLIC_DEV_WALLET=1`); used for screenshots in `app/docs/screens/redesign-*.png`.

## Characters and the three product screens (p2)

Approved mockups: `art-source/ui-redesign/{result-won,wallet,backing}-desktop/take-1.png`. Screenshots and side-by-side comparisons are in `app/docs/screens/p2-*.png` (`app/scripts/screenshot-p2.mjs`, `compare-p2.mjs`).

**Character placement rule (founder, Sep 30: "too much in the design").** him = the Player / guide, her = the Backer. Characters are decorative (empty alt), never carry information and never overlap text or controls. **Only torso-up crops exist in the app** (`art.busts`, generated by `app/scripts/make-busts.mjs` into `public/art/final/characters/bust/`; the full-body poses are source art and are never rendered). There are exactly three ways a character appears:

1. **Bust card** (`<BustCard>`, `components/ui/Character.tsx`): a bust flush to the bottom edge of an explainer, tip or empty-state card.
2. **Corner guide** (`<GuideProvider>`, `<GuideCorner>`, `useGuideTip`, `components/guide`): a small bust with a speech bubble for a contextual tip, docked in chrome so it never covers page content: at the bottom of the sidebar (under Docs / Help) from 1024px, and a small tappable chip at the left end of the bottom nav below 1024px, whose bubble opens above it on demand (Escape or "Got it" closes it). One at a time, dismissible ("Got it"), dismissal remembered per tip id in localStorage, hidden while a game is running (`useGuideHidden`). Screenshots: `app/docs/screens/simguide-*` (`app/scripts/screenshot-sim-guide.mjs`).
3. **Moment overlay** (`MomentOverlay`, `components/match`): the win and backed-win celebration, bust plus the Gema burst over the result for about 3 s or until clicked, once per Match per tab. The result screen underneath has no character.

Never full-body inside a page layout, and never during play: no character in the Block Puzzle or Hold'em screens, on desktop or mobile.

| Where | Character |
|---|---|
| Match result, Player won | overlay: `him-win` bust |
| Match result, Backer, backed win | overlay: `duo-win` crop |
| Match result, Lost / Draw / Refunded | none |
| Wallet, Open a Position | bust card "How Gemas work": `him-explain` |
| Wallet, first visit | guide tip: `him-explain` ("Pending is not lost") |
| Wallet, Opening an ETH Position | guide tip: `her-waiting-crosschain` ("LayerZero usually takes 2–5 minutes") |
| Lobby, first visit | guide tip: `him-welcome` |
| Backing, first visit | guide tip: `her-backing` ("What Backing means") |
| Backing, empty states | bust card: `her-empty` |
| Game page (`/play/<game>`) | bust card "How to play": `him-explain` |

**Match result.** One focused card (max 760px): game and rule line, outcome, amount, scores, entry and fee; the actions sit under it, nothing else competes. Won shows the faceted emerald burst behind "+N Gemas" and always the line "Pending · redeemable as their yield lands" linking to the Wallet: won Gemas are claims on the loser's Source, never cash in hand. Loss is neutral-white with a danger icon; no burst. Backed Matches show the split (BackingSplit); the backed Player is told they never owe anything. Hold'em shows a Chips-free result (Won / Lost tiles).

**Wallet.** `wl-*` classes. One balance hero (`.facet-panel`, money only): Total Balance big, Redeemable now (with the Redeem action) and Pending as two secondary figures, Pending by Source behind a toggle. "Open a Position" is a header button that opens a sheet (chain tabs, Amount, Horizon, Gemas issued and Unlock Estimate from the real quote). Positions are a grid of cards showing only Principal, Debt and Unlock Estimate; APY and the Debt chart (a projection from the live yield rate, labelled projected) sit behind "Details". Only chains with a Position get a card; HYPE is a muted line ("coming soon"). The "How Gemas work" bust card appears once, below the Positions. Copy rule: "Your Principal is never played", never "protected".

**Game page, play screens, cross-chain tracker (p2b).** Mockups `{game-block-puzzle,play-block-puzzle,play-holdem,wallet-crosschain}-desktop/take-1.png`; screenshots `app/docs/screens/p2b-*.png` and `p2b-compare-*.png` (`app/scripts/screenshot-p2b.mjs`).
- `/play/<game>` (`block-puzzle`, `holdem`) is the Game's detail page, linked from the Lobby tile: a hero with the entry picker, Play now, Challenge a friend (and Practice for Block Puzzle); below it two sections only: Recent Matches (with Top scores today inside it when Block Puzzle has winners from the last 24 h on chain) and the How to play bust card. `/play` redirects to Block Puzzle.
- Block Puzzle play: the board is the centre. A slim bar above it carries the score, the 90 s ring, Combo ×n and Lines, and Entry · Pot; the opponent status and Seed sit in one line under the tray. No Recent list during play (the last clears show on the game-over card). Practice (`/play/practice`) is the same screen with nothing staked.
- Hold'em play: a slim header (title, blinds, hand #, entry, turn clock), the octagonal navy table with a steel rim centred and large (no green felt), the action bar (Fold, Check, Call, Raise, Raise to, slider, presets, All-in), and the Hand log in a collapsed drawer (inferred by this client from table reads; a poll can merge two actions, and it says so).
- `/wallet/opening`: OPENING YOUR ETH POSITION, four steps (Hoodi confirmed, LayerZero delivered, Position recorded, Gemas available). Only the last step means Gemas exist; pending never shows a check. Shown right after "Open an ETH Position": the four-step tracker plus one summary line and one note; the corner guide explains the wait. The Wallet's in-page trackers remain.
- Dev only: `/design/play` (Block Puzzle Match screen, local Seed) and `/design/table` (Hold'em table on a fixed hand, `?facing=1`).

**Backing.** Page header with a "Post a Request" button (opens a sheet) and tabs Requests / Public Offers / My Backings with one Sort select. Request cards sit in a calm grid (avatar, handle, game, "N Matches · X% won", Requested entry, Make an Offer); no game art strip. The MAKE AN OFFER drawer opens on demand over the page from the right (a bottom sheet below 1024px). Banners show only when actionable (a funded Backing, an Offer for you, an error or confirmation).

## Layout and density

The founder's rule (Oct 1): the website must not copy the mockups' density. Mockups are vertical images that tuck everything together; the app scrolls.

- **Pages scroll.** Do not fit everything into one viewport. Each section has one job, with 64–96px between sections on desktop (`--section-gap`: 56px, 80px from 1024px) and a capped, centred column (max 1320px); 1920px screens get margins, not more stuff.
- **One primary action per screen**, obvious. Secondary information goes behind progressive disclosure: `<details>` toggles ("Details", "Pending by Source", the Hand log), hover and tooltips, and sheets or drawers that open on demand (Open a Position, Post a Request, Make an Offer, Redeem).
- **Fewer simultaneous panels**, fewer labels and meta lines, fewer type sizes, more line-height. A number appears once per screen.
- **Global chrome is minimal**: the sidebar is navigation only, the top bar holds the balance pill and the Account (search on the Lobby only), the footer is one line plus links. Category chips belong to the Lobby's Play now section only.
- **Play screens** centre the game (board or table) with a slim bar above; side columns do not exist. Info that is not needed mid-play moves to the result.
- **Mobile (390px)** applies the same simplifications; secondary content goes in sheets; nothing crowds horizontally.
- Screenshots for this pass: `app/docs/screens/declutter-*-before.png` and `-after.png` (`app/scripts/screenshot-declutter.mjs`); live proof by `app/scripts/live-declutter.mjs`.

Dev only: `/design/result?case=won|lost|draw|refunded|backed-player|backed-lost|backer-won|backer-lost|holdem-won|holdem-lost` renders every result variant from fixtures (`NEXT_PUBLIC_DEV_WALLET=1`).
