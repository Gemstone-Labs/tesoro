# Tesoro Design

**Direction: Cut.** The game is the star; the platform is quiet, neutral chrome. Tesoro's signature is its *shape* — the emerald cut — and emerald appears only where Gemas move. Reference study: `docs/design/emerald-directions-study.html` (the "Cut" row).

## Principles

- **Chrome stays out of the way.** Near-black neutral shell; game art supplies the colour. No atmosphere, glow, texture or ornament on platform surfaces.
- **The cut is the brand.** Chamfered (octagonal) corners on the phone frame, cards, rows, chips, entries and buttons — never rounded rectangles or pills. One corner size per component class.
- **Emerald means Gemas move.** Emerald and faceted light (hard-stop gradients) are reserved for the balance, the chosen entry, redeemable amounts and money actions (Enter, Offer, Redeem). If it's emerald, Gemas move.
- **Money is plain, big and honest.** Every balance separates *redeemable now* from *pending*, and pending shows its Sources. Simulated yield is labelled wherever amounts are shown.
- **Green is not "success".** Because the accent is green, confirmations and wins always carry a second signal (icon or words), never colour alone.

## Tokens

```css
:root {
  /* shell */
  --shell: #0C0E10; --raised: #15181B; --line: rgba(234,239,236,.10);
  --fg: #EAEFEC; --fg-2: rgba(234,239,236,.62); --fg-3: rgba(234,239,236,.40);
  /* emerald — money only */
  --em-hi: #8FF5CF; --em: #2DBE8C; --em-deep: #0B6B4E; --em-ink: #03201A;
  --facet: linear-gradient(135deg, var(--em-hi) 0%, var(--em) 45%, #1FA877 45.5%, var(--em-deep) 100%);
  /* semantic (never the accent) */
  --danger: #F2685A; --warn: #F2B94B;
  /* type */
  --f-body: "Schibsted Grotesk", "Hanken Grotesk", system-ui, sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, monospace;
  /* cut sizes */
  --cut-frame: 22px; --cut-card: 10px; --cut-chip: 6px;
}
.cut { clip-path: polygon(var(--c) 0, calc(100% - var(--c)) 0, 100% var(--c), 100% calc(100% - var(--c)), calc(100% - var(--c)) 100%, var(--c) 100%, 0 calc(100% - var(--c)), 0 var(--c)); }
```

## Type

Schibsted Grotesk for everything, headings and figures included (weights 400/700/800/900, tight tracking on large numbers, `tabular-nums` on every amount). IBM Plex Mono only for verifiable data: chain chips, hashes, Seeds, timers, the simulated-yield label.

## The Gema mark

A small emerald-cut stone (octagon with table facet and facet lines, emerald gradient) — never a flat ◆ glyph, never gold. It precedes Gema amounts of consequence; a brief glint animation is allowed on the balance only, and is off under `prefers-reduced-motion`.

## Layout

Mobile-first, three-destination bottom navigation (Lobby · Play · Wallet), game-first lobby in the Skillz shape: featured game with its entry ladder, game rows, Backing Requests. Desktop widens the same composition; it does not add chrome.

## Implementation decisions (from the first build, 2026-09-30)

- `--fg-3` (40%) fails AA for text: use it for decoration only; all text uses `--fg` or `--fg-2`.
- Navigation and non-money CTAs (Play, See all) are neutral; only Gema actions (Enter, Offer, Redeem, Take an Advance, sliders that set Gema amounts) are emerald.
- Focus rings sit inside cut shapes (`outline-offset: -4px`), since `clip-path` clips outer outlines; `--em-ink` on money buttons.
- Heavy Schibsted (800–900) gets `word-spacing: .14em`.
- Match results always pair an icon with words: ✓ Won · ✕ Lost · − Draw / Refunded.
- Simulated Unlock Estimates show an absolute time (the yield clock runs 1 month = 10 min).
- Components live in `app/src/components/ui`; `/design` renders every component and state.
