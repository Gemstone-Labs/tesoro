# Tesoro Design

**Direction: Cut, lit.** The game is the star; the platform is quiet, neutral chrome. Tesoro's signature is its *shape* — the emerald cut — and emerald appears only where Gemas move. Reference 0 is the approved Lobby mockup `art-source/ui-redesign/lobby-desktop/take-1.png` (1920×1200); structure follows Skillz (`attach/10-ref-skillz-desktop.jpg`), hero drama follows `attach/11-ref-chumba-desktop.jpg`. Original study: `docs/design/emerald-directions-study.html` (the "Cut" row).

Tesoro is a **desktop web app first** (sidebar, top bar, rails); phone and tablet are the same app collapsed, never a different product.

## Principles

- **Chrome stays out of the way.** Near-black neutral shell; game art supplies the colour. No atmosphere, glow, texture or ornament on platform surfaces.
- **The cut is the brand.** Chamfered (octagonal) corners on every card, chip, button, search box, balance pill, arrow button, avatar and tile — never rounded rectangles or pills. One corner size per component class, and the 1px outline follows the chamfer.
- **Emerald means Gemas move.** Emerald and faceted light (hard-stop gradients) are reserved for the balance pill, the chosen entry, redeemable amounts and money actions (Play now, Enter, Offer, Redeem). If it's emerald, Gemas move. Navigation, chips, arrows and Docs/Help are neutral.
- **Money is plain, big and honest.** Every balance separates *redeemable now* from *pending*, and pending shows its Sources. Simulated yield is labelled wherever amounts are shown.
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

## The Gema mark

A small emerald-cut stone (octagon with table facet and facet lines, emerald gradient) — never a flat ◆ glyph, never gold. It precedes Gema amounts of consequence and is the sidebar wordmark's gem; a brief glint animation is allowed on the balance only, and is off under `prefers-reduced-motion`.

## Shell and layout

- **Desktop (≥1024px):** fixed left sidebar (`--side-w`), then a sticky top bar over the content.
  - Sidebar, top to bottom: wordmark with gem, "Fair play · on-chain" chip, Lobby / Play / Backing / Wallet (active item raised and outlined), divider, Docs / Help (not built yet: shown dimmed, not clickable), the **Your Positions** card. The card shows each Position (chain chip, principal, a 10-segment bar of Debt repaid by yield, Debt), the Unlock Estimate, the emerald **Redeemable now** panel and the **Pending** panel; real data when signed in, a sign-in prompt when not.
  - Top bar: search (filters games on the Lobby; typing elsewhere goes to the Lobby), the Gema balance pill (emerald, links to Wallet) and the Account avatar menu (Account, Wallet, Sign out). Signed out: a Sign in button instead.
  - The Lobby content is full width up to the viewport edge; every other page is a centred column (max 1180px).
- **Below 1024px:** the sidebar becomes a left drawer (menu button in the top bar), a four-item bottom navigation appears, the search box drops to its own row on the Lobby, and rails show a peeking next tile (horizontal scroll).
- **Lobby order:** category chips (Puzzle, Cards, Head-to-head, Async filter Play Now; Backing scrolls to Back a Player) → hero carousel (active slide plus the next slide peeking, dots, next arrow, auto-advance that pauses on hover, focus and a Pause button, and stops under `prefers-reduced-motion`) → Continue (only with Matches in progress) → Play Now → Play Again (only with settled Matches) → live ticker → Back a Player → footer.
- **Rails:** a bold condensed header, `VIEW ALL →`, and ← → cut arrow buttons that scroll the track. Tiles per screen follow the container width, not the viewport (6 / 5 / 4 / 3 / peeking).

## Components

Live in `app/src/components/ui` (primitives, money, inputs, icons, `ui.css`), the shell in `components/shell`, Lobby pieces in `components/lobby`. `/design` renders every ui component and state.

- **Button** — `money` (facet gradient) only where Gemas move; `neutral` otherwise; sizes `sm`, `md`, `lg` (Play now).
- **Icon button** (`.icon-btn`) — square cut button for arrows, menu, close, copy.
- **Entry picker** — 500 / 1,000 / 2,500; the chosen entry is facet-filled with the Gema mark.
- **Tile** — Play Now key art with a bottom label; coming-soon variant dimmed with a "Coming soon" chip.
- **Player card** — avatar, name, Game, "N Matches · X% won", Entry, emerald **Offer**.
- **Ticker**, **Balance pill**, **Positions card**, **Category chip**, **Search**, **Account menu** — see the shell and Lobby.
- Icons: neutral `lucide-react` line icons (1.7–1.8 stroke) in the shell; the original square-cap glyphs in `ui/icons.tsx` remain for status marks (check, cross, clock).

## Art

All game art, hero art and avatars come from one map, `app/src/lib/art.ts`. Until the final assets land (`art-source/ui-redesign/assets/`), they are **placeholder crops of take-1** produced by `app/scripts/crop-placeholder-art.mjs` into `app/public/art/placeholder/`; swapping to final art is one line per image. Hero art keeps its left 40% dark for the title. Art carries no UI text (titles, chips and prices are real text).

## Implementation decisions

- `--fg-3` (40%) fails AA for text: decoration only; all text uses `--fg` or `--fg-2`.
- Only Gema actions (Play now, Enter, Offer, Redeem, Take an Advance, sliders that set Gema amounts) and the balance are emerald. The Debt-repaid segments in the Positions card are emerald because they are Debt paid by yield.
- Money buttons use `--em-ink` for text and focus rings.
- Match results always pair an icon with words: ✓ Won · ✕ Lost · − Draw / Refunded (Play Again tiles too).
- Simulated Unlock Estimates show an absolute time (the yield clock runs 1 month = 10 min); "–" until one exists.
- Names are not on chain: Players show as short keys with a stable placeholder avatar (`avatarFor`).
- Dev only: `?dev=out` previews the signed-out UI and `?dev=demo` a populated fake Account (with `NEXT_PUBLIC_DEV_WALLET=1`); used for screenshots in `app/docs/screens/redesign-*.png`.
