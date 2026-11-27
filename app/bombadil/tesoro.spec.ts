import { always, eventually } from "@antithesishq/bombadil";
import { isAction } from "@antithesishq/bombadil/actions";
import { actions, extract, registerCustomAction, weighted } from "@antithesishq/bombadil/browser";
import { clicks, inputs, scroll } from "@antithesishq/bombadil/browser/defaults/actions";
import { noResourceLeak } from "@antithesishq/bombadil/browser/extras/resources";

export * from "@antithesishq/bombadil/browser/defaults/properties";

const page = extract(({ document, window }) => {
  const text = document.body?.innerText ?? "";
  const root = document.documentElement;
  const overlay = document.querySelector("nextjs-portal")?.shadowRoot;
  return {
    path: window.location.pathname,
    overflow: root.scrollWidth - root.clientWidth,
    invalidText: text.match(/\b(?:NaN|undefined)\b/)?.[0] ?? null,
    errorBoundary: root.id === "__next_error__" ||
      !!overlay?.querySelector("[data-nextjs-dialog-overlay]") ||
      /application error:\s*a (?:client|server)-side exception|unhandled runtime error|internal server error/i.test(text),
  };
});

export const fitsViewport = always(() => page.current.overflow <= 0);
export const validVisibleText = always(() => page.current.invalidText === null);
export const noApplicationError = always(() => !page.current.errorBoundary);

// The default HTTP property covers the document. Include fetches, scripts and other subresources.
const failedResources = extract(({ window }) => window.performance.getEntriesByType("resource")
  .filter((entry) => (entry as PerformanceResourceTiming).responseStatus >= 500)
  .map((entry) => entry.name));
export const noServerErrors = always(() => failedResources.current.length === 0);

// The waitlist mounts hundreds of <video> elements. Repeated /play -> / -> /play probes
// measured ~76k extra CDP nodes and ~9.6k listeners on mount. After collection, /play
// settled at 49k nodes / 484 listeners on desktop and 45k / 462 on mobile.
export const boundedDomNodes = noResourceLeak({ metric: "dom_nodes", growthLimit: 100_000, windowMillis: 10_000 });
export const boundedListeners = noResourceLeak({ metric: "js_event_listeners", growthLimit: 12_000, windowMillis: 10_000 });

const footprint = extract(({ document, resources }) => ({
  videoWall: !!document.querySelector(".vw video"),
  nodes: resources.dom_nodes,
  listeners: resources.js_event_listeners,
}));
// Catch resources retained after unmount, even when no single mount exceeds its growth budget.
export const resourcesRecover = always(() => eventually(() => footprint.current.videoWall ||
  (footprint.current.nodes <= 60_000 && footprint.current.listeners <= 3_000)).within(20, "seconds"));

// A fullscreen effects canvas can sit *behind* the controls. Filter by the actual hit target.
const canvasHits = extract(({ document }) => {
  if (!document.querySelector("canvas")) return [];
  const hits: string[] = [];
  for (const element of document.querySelectorAll("a, button, input, textarea, label, [role]")) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (element.closest("canvas") || document.elementFromPoint(x, y)?.closest("canvas")) hits.push(`${x},${y}`);
  }
  return hits;
});
const uiClicks = clicks.filter(action =>
  isAction(action, "Click") && action.Click.fingerprint.tag.toLowerCase() !== "canvas" &&
  !canvasHits.current.includes(`${action.Click.point.x},${action.Click.point.y}`),
);

const visit = registerCustomAction("visitRoute", async (_document, window, path: string) => {
  window.location.assign(path);
});
const routes = ["/play", "/play/practice?game=holdem", "/vault", "/backing", "/leaderboard", "/docs"];
const interact = weighted([[8, uiClicks], [2, inputs], [1, scroll], [1, "Wait"]]);
let visits = 0;
let interactionsLeft = 4;
// Cover the entry points first, then spend longer exploring each route between navigations.
export const explore = actions(() => {
  if (interactionsLeft-- > 0) return interact.generate();
  visits++;
  interactionsLeft = visits < routes.length ? 4 : 14;
  return [visit(routes[visits % routes.length]!)];
});
