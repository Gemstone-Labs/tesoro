# Storybook

Every screen, component, asset, transition and animation of the app, rendered from fixtures. Nothing in it reads devnet, Hoodi, HyperEVM or the rollup.

```bash
pnpm --filter @tesoro/app storybook         # http://localhost:6006
pnpm --filter @tesoro/app build-storybook   # static build in app/storybook-static
```

A static build is published at https://tesoro-storybook.vercel.app (Vercel project `tesoro-storybook`). It only changes when someone redeploys it: `scripts/deploy-storybook.sh` builds the committed HEAD in a throwaway worktree, so uncommitted work stays out, and deploys it to production.

Edit a component or its CSS and the story reloads. Copy, numbers and states can also be changed live in the **Controls** panel; those changes are not saved.

## Sidebar

| Section | What's in it |
|---|---|
| Introduction | This page in short |
| Foundations | Colour tokens (read live from `globals.css`), type, the cut, the Gema mark, icons |
| Brand | Mark, logo and every SVG in `public/brand` |
| Assets | All art from the manifests (`lib/art.ts`, `lib/landing/art*.ts`), video loops, the 3D gem, app icons |
| Motion | Every `@keyframes`, transition and JS animation, with Replay and timing controls |
| Components | Each shared component with controls and its states |
| Games | Block Puzzle, Hold'em and Trading Duel, playable and in fixed states |
| Screens | Every route in its real shell, one story per state; **Match flow** plays a whole Match step by step (below) |

## Toolbar

- **Auth**: signed in as the demo Account, signed out, or signing in. A story can pin it with `parameters.auth`.
- **Theme**: light or dark for the landing and docs. The app shell is always dark.
- **Motion**: reduced motion. JS reads it through `matchMedia`; CSS animations are cut by a Storybook-only class, which approximates the real media query. For the exact CSS behaviour, use the browser's rendering emulation.
- **Guide**: shows the Guide character's tips. Off by default so they don't cover every screen; when on, dismissals are forgotten on every story.
- **Viewport**: 1920, 1440, 1024 and 390, the widths used by the screenshot scripts.

## Where things live

- `app/.storybook/main.ts`, `preview.tsx`: config, global CSS, decorators, toolbar.
- `app/stories/<section>/`: the stories. `app/stories/support/`: auth states, story data, layouts, fonts, the network block.
- `app/.storybook/mocks/src/...`: module mocks. A file there replaces the file at the same path under `app/src/` for every importer; the mock can still import the real one by its relative path. Restart Storybook after adding a mock file.

## Data in stories

Demo mode is always on, so the hooks with a demo branch (`lib/chain/fixture.ts`) read fixtures. A story picks its state with `parameters`:

```tsx
export const NoPositions: Story = {
  parameters: {
    shell: "app",                       // "app" | "marketing" | "docs" | "none": the route-group layout around the story
    auth: "signed-out",                 // overrides the toolbar
    data: { snapshot: (a) => ({ ...demoSnapshot(a), positions: [] }) }, // see stories/support/data.ts
    nextjs: { navigation: { pathname: "/wallet" } },
  },
};
```

`data.snapshot` is the signed-in Account (`null` = still loading), `data.snapshotError` the failed read, and `board`, `settled` and `playerAccount` replace the demo Backing board, recent wins and Account pages. `DEMO_ME` (in `stories/support/data.ts`) is the signed-in Account's key, so its Account page is "your own".

Any fetch or WebSocket that isn't a local static file fails at once with "Offline in Storybook", so a story without a mock shows the component's error or empty state rather than hanging.

## Match flow

`Screens/Match flow` runs the real Queue / Challenge page, MatchRoute and the Game's Match view through a list of steps (`stories/screens/MatchFlow.stories.tsx`). Each step (`Frame` in `stories/screens/support/flow-store.ts`) says what the page shows, what the chain mocks answer while it is current, and what happens underneath, which the dock prints. The mocks follow it: `enterQueue`, `enterQueueBacked`, `createChallenge` and `joinChallenge` report each step's `status` and land at the step marked `entered`; MatchRoute's Match read answers at `routed`; Block Puzzle's `prepareRun` reports `screen.run.step` until the run is ready. A step with `click` presses that button on arrival; `remount` starts the page afresh where the real one would get there by polling.

To add a step, add a frame to the flow; if the app gains a new progress line, add it there so the dock stays true to the code.

## Checking every story

```bash
PW=/path/to/playwright-core BASE=http://localhost:6006 node app/scripts/storybook-smoke.mjs [filter] [--shots=dir]
```

`BASE=https://tesoro-storybook.vercel.app` checks the published build. Run the published build a section at a time: in one long run the reused tab runs out of memory around story 100.

It opens every story (or those whose id contains `filter`), and fails on a page error, a console error, or a request to anything but localhost and Google Fonts. `--shots` saves a screenshot of each at 1440 and 390.
