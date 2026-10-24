/** Throwaway comparison. Same DOM renderer/art/rules/haptics for every variant.
 * This isolates motion mapping and score presentation; it is not a production
 * performance baseline. See the private investigation for evidence and limits.
 */
import { dims, fitsAt, pieceCells, type Piece } from "../engine";
import { measureGrid, pieceExtent, type GridGeometry } from "../drag-geometry";
import { wouldClear, clearCallout } from "../feel";
import { createScorePresentation } from "../score-presentation";
import { blockHaptics } from "../haptics";
import { armSound, blockSound, isMuted, setMuted } from "../../fx/sfx";
import { FIXTURES, initialFixture, hand, attemptPlacement, guidedSteps, EMPTY_COLOR, type FixtureId, type PlacementOutcome } from "./model";
import { heldPosition, pickupGeometry, placementTarget, measuredMotion, splitCredit, type Variant } from "./motion";
import "./prototype.css";

const app = document.querySelector<HTMLElement>("#app")!;
const params = new URLSearchParams(location.search);
const variants: Variant[] = ["current", "motion", "credit", "combined"];
let variant: Variant = variants.includes(params.get("variant") as Variant) ? params.get("variant") as Variant : "combined";
let fixture: FixtureId = FIXTURES.some(f => f.id === params.get("fixture")) ? params.get("fixture") as FixtureId : "single";
app.innerHTML = `<div class="lab">
  <header class="lab-header"><h1>Block Burst</h1><span class="lab-tag">Interaction prototype</span></header>
  <div class="lab-controls">
    <select id="variant" aria-label="Comparison variant"><option value="current">A · Current</option><option value="combined">B · Measured</option><option value="motion">Motion only</option><option value="credit">Score only</option></select>
    <select id="fixture" aria-label="Controlled sequence">${FIXTURES.map(f => `<option value="${f.id}">${f.label}</option>`).join("")}</select>
    <button id="reset" class="lab-button">Reset</button>
  </div>
  <div class="lab-hud"><span class="lab-small"><b id="timer">90</b>s<br>Practice fixture</span>
    <div class="lab-score"><span class="bp-score-n" id="score" aria-label="Score">0</span></div>
    <div class="lab-settings"><button id="sound" aria-label="Sound"></button><button id="vibration" aria-label="Vibration"></button><button id="fullscreen" aria-label="Enter full screen">⛶</button></div>
  </div>
  <div class="lab-stage"><div class="bp-board-space"><div class="bp-board-visual"><div class="bp-board live" role="grid" aria-label="Block Burst prototype board, 8 by 8"></div><div class="lab-effects" aria-hidden="true"></div></div></div><div class="bp-tray" aria-label="Pieces"></div></div>
  <div class="lab-summary"><span id="progress">0 moves · 0 lines</span><span id="status" role="status">Drag a piece onto the board</span></div>
  <p class="lab-guide" id="guide"></p>
  <details class="lab-readout"><summary>Comparison and event record</summary>
    <p id="comparison"></p><p>Fixture boards only. Competitive points, seeded piece order and the 90-second limit use the current rules. Combo still resets on an ordinary placement; the reference’s complete reset rule is unknown.</p>
    <p>Both variants use the same lightweight renderer, artwork, sounds, vibration and clear timing. A reproduces current motion and score timing; it does not reproduce the production app’s performance.</p>
    <p id="truth"></p><ol class="lab-events" id="events"></ol>
  </details>
  <p class="lab-footer">Compare B with Block Blast on your Seeker. Reset repeats the same board and pieces. Dashed cells mark the next guided target; free placement also works.</p>
</div>`;

const board = app.querySelector<HTMLDivElement>(".bp-board")!;
const space = app.querySelector<HTMLDivElement>(".bp-board-space")!;
const visual = app.querySelector<HTMLDivElement>(".bp-board-visual")!;
const effects = app.querySelector<HTMLDivElement>(".lab-effects")!;
const tray = app.querySelector<HTMLDivElement>(".bp-tray")!;
const score = app.querySelector<HTMLElement>("#score")!;
const status = app.querySelector<HTMLElement>("#status")!;
const events: { ms: number; type: string; detail: string }[] = [];
let state = initialFixture(fixture);
let selected = 0;
let combo = 0;
let epoch = performance.now();
let deadline: number | null = null;
let expired = false;
let shown = 0;
let targetScore = 0;
let scoreFrame = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const later = (fn: () => void, ms: number) => {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
  timers.add(timer);
};
const snapshot = () => ({ variant, fixture, score: state.st.score, shown: targetScore, moves: state.st.moves, lines: state.lines, used: state.st.used, occupancy: state.st.occ.toString(), expired, events: events.slice() });
Object.defineProperty(window, "burstLab", { get: snapshot });

function record(type: string, detail: string) {
  events.push({ ms: Math.round(performance.now() - epoch), type, detail });
  app.querySelector("#events")!.innerHTML = events.slice(-10).map(e => `<li>${e.ms}ms · ${e.type}: ${e.detail}</li>`).join("");
  app.dataset.score = String(state.st.score);
  app.dataset.shown = String(targetScore);
  app.dataset.moves = String(state.st.moves);
  app.dataset.lines = String(state.lines);
  app.querySelector("#truth")!.textContent = `Authoritative score ${state.st.score}; received ${targetScore}; pending ${state.st.score - targetScore}.`;
}

const receipts = createScorePresentation((total) => {
  targetScore = total;
  cancelAnimationFrame(scoreFrame);
  const from = shown, start = performance.now();
  const tick = () => {
    const t = reduced() ? 1 : Math.min(1, (performance.now() - start) / 180);
    shown = from + (total - from) * (1 - (1 - t) ** 3);
    score.textContent = String(Math.round(shown));
    if (t < 1) scoreFrame = requestAnimationFrame(tick);
  };
  tick();
  record("score received", String(total));
});

const cells = Array.from({ length: 64 }, (_, i) => {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "bp-cell";
  node.setAttribute("role", "gridcell");
  node.setAttribute("aria-label", `Row ${Math.floor(i / 8) + 1}, column ${i % 8 + 1}`);
  node.addEventListener("click", e => { if (e.detail === 0 && !gesture) place(selected, i % 8, Math.floor(i / 8)); });
  board.appendChild(node);
  return node;
});
const slots = Array.from({ length: 3 }, (_, slot) => {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "bp-slot";
  node.dataset.slot = String(slot);
  node.setAttribute("aria-label", `Pick up piece ${slot + 1}`);
  node.addEventListener("pointerdown", e => begin(e, slot));
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", release);
  node.addEventListener("pointercancel", () => cancel("pointer cancelled"));
  node.addEventListener("lostpointercapture", () => { if (gesture?.node === node) cancel("capture lost"); });
  node.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { selected = slot; render(); } });
  tray.appendChild(node);
  return node;
});

function mini(piece: Piece, cell: number, gap: number) {
  const [w, h] = dims(piece);
  const node = document.createElement("span");
  node.className = "bp-mini";
  node.style.gridTemplateColumns = `repeat(${w},${cell}px)`;
  node.style.gridTemplateRows = `repeat(${h},${cell}px)`;
  node.style.gap = `${gap}px`;
  for (const c of pieceCells(piece)) {
    const item = document.createElement("span");
    item.className = `bp-cell k${piece.kind % 4}${c.gem ? " gem" : ""}`;
    item.style.gridColumn = String(c.dx + 1);
    item.style.gridRow = String(c.dy + 1);
    node.appendChild(item);
  }
  return node;
}

function render() {
  const nextStep = guidedSteps(fixture)[state.st.moves];
  const target = new Set(nextStep ? pieceCells(hand(state)[nextStep.slot].piece).map(c => (nextStep.y + c.dy) * 8 + nextStep.x + c.dx) : []);
  for (let i = 0; i < 64; i++) {
    const on = state.colors[i] !== EMPTY_COLOR;
    cells[i].className = `bp-cell${on ? ` on k${state.colors[i]}` : ""}${(state.st.gems >> BigInt(i)) & 1n ? " gem" : ""}${target.has(i) ? " lab-target" : ""}`;
  }
  for (const item of hand(state)) {
    const node = slots[item.slot];
    node.disabled = item.used || state.st.over || expired;
    node.className = `bp-slot${item.used ? " used" : ""}${selected === item.slot ? " sel" : ""}`;
    node.replaceChildren();
    if (!item.used) node.appendChild(mini(item.piece, Math.min(18, (node.clientWidth - 18) / 4), 2));
  }
  app.querySelector("#progress")!.textContent = `${state.st.moves} moves · ${state.lines} lines`;
  app.querySelector("#guide")!.textContent = nextStep ? `${state.st.moves + 1}/3 · ${nextStep.title}.` : "Sequence complete. Continue freely or Reset to compare the same moves.";
  app.dataset.occupancy = state.st.occ.toString();
}

function preview(anchor: { x: number; y: number } | null, piece: Piece) {
  renderBoardOnly();
  if (!anchor) return;
  const valid = fitsAt(state.st, piece, anchor.x, anchor.y);
  const hint = valid ? wouldClear(state.st, piece, anchor.x, anchor.y) : { rows: [], cols: [] };
  for (const c of pieceCells(piece)) {
    const cell = cells[(anchor.y + c.dy) * 8 + anchor.x + c.dx];
    cell?.classList.add("pv", valid ? `pk${piece.kind % 4}` : "bad");
  }
  board.style.setProperty("--hk", ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"][piece.kind % 4]);
  cells.forEach((cell, i) => { if (hint.rows.includes(Math.floor(i / 8)) || hint.cols.includes(i % 8)) cell.classList.add("hint"); });
}
function renderBoardOnly() {
  for (const cell of cells) cell.classList.remove("pv", "pk0", "pk1", "pk2", "pk3", "bad", "hint");
}

interface Gesture {
  pointer: number; slot: number; node: HTMLButtonElement; piece: Piece; grid: GridGeometry;
  sx: number; sy: number; startLeft: number; startTop: number; left: number; top: number; gain: number; moved: boolean; ghost: HTMLElement;
}
let gesture: Gesture | null = null;

function begin(e: PointerEvent, slot: number) {
  if (gesture || !e.isPrimary || e.button !== 0 || expired || state.st.over) return;
  const piece = hand(state)[slot].piece;
  const node = slots[slot];
  const art = node.querySelector<HTMLElement>(".bp-mini")!;
  if (!art) return;
  selected = slot;
  const rect = art.getBoundingClientRect();
  const grid = measureGrid(space, board);
  const geometry = pickupGeometry(piece, rect, { x: e.clientX, y: e.clientY }, grid, variant, e.pointerType === "touch", space.getBoundingClientRect().bottom);
  const ghost = document.createElement("div");
  ghost.className = "bp-ghost lab-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const pickup = document.createElement("div");
  pickup.className = "bp-pickup";
  if (e.pointerType === "touch" && measuredMotion(variant)) pickup.style.animation = "none";
  pickup.style.setProperty("--pickup-x", `${rect.left - geometry.left}px`);
  pickup.style.setProperty("--pickup-y", `${rect.top - geometry.top}px`);
  pickup.style.setProperty("--pickup-scale", String(geometry.scale));
  pickup.appendChild(mini(piece, grid.cell, grid.gap));
  ghost.appendChild(pickup);
  ghost.style.transform = `translate3d(${geometry.left}px,${geometry.top}px,0)`;
  document.body.appendChild(ghost);
  gesture = { pointer: e.pointerId, slot, node, piece, grid, sx: e.clientX, sy: e.clientY, startLeft: geometry.left, startTop: geometry.top, left: geometry.left, top: geometry.top, gain: geometry.gain, moved: false, ghost };
  node.classList.add("held");
  node.setPointerCapture(e.pointerId);
  if (deadline === null) deadline = performance.now() + 90_000;
  record("pickup", `piece ${slot + 1}; motion ${geometry.gain}×; lift ${Math.round(geometry.lift)}px`);
}

function move(e: PointerEvent) {
  const g = gesture;
  if (!g || e.pointerId !== g.pointer) return;
  g.moved ||= Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= 4;
  const p = heldPosition({ x: g.sx, y: g.sy, left: g.startLeft, top: g.startTop }, { x: e.clientX, y: e.clientY }, g.gain);
  g.left = p.left; g.top = p.top;
  g.ghost.style.transform = `translate3d(${p.left}px,${p.top}px,0)`;
  if (g.moved) preview(placementTarget(g.piece, p.left, p.top, g.grid), g.piece);
}

function cancel(reason?: string) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  g.ghost.remove();
  g.node.classList.remove("held");
  if (g.node.hasPointerCapture(g.pointer)) g.node.releasePointerCapture(g.pointer);
  renderBoardOnly();
  if (reason) record("cancel", reason);
}

function release(e: PointerEvent) {
  const g = gesture;
  if (!g || e.pointerId !== g.pointer) return;
  move(e);
  const anchor = g.moved ? placementTarget(g.piece, g.left, g.top, g.grid) : null;
  const accepted = anchor && place(g.slot, anchor.x, anchor.y);
  if (!accepted && g.moved) {
    status.textContent = "Returned · no points spent";
    record("invalid drop", anchor ? "occupied or outside piece bounds" : "outside board");
    if (!reduced()) {
      const node = g.ghost.cloneNode(true) as HTMLElement;
      node.classList.add("bp-return", "lab-effect");
      document.body.appendChild(node);
      const rect = g.node.querySelector<HTMLElement>(".bp-mini")!.getBoundingClientRect();
      const animation = node.animate([
        { transform: `translate(${g.left}px,${g.top}px) scale(1)`, opacity: .95 },
        { transform: `translate(${rect.left}px,${rect.top}px) scale(${rect.width / pieceExtent(dims(g.piece)[0], g.grid)})`, opacity: .3 },
      ], { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" });
      animation.onfinish = animation.oncancel = () => node.remove();
    }
  }
  cancel();
}

function place(slot: number, x: number, y: number) {
  if (expired || deadline !== null && performance.now() >= deadline) { expire(); return false; }
  const next = attemptPlacement(state, slot, x, y);
  if (!next.accepted) return false;
  state = next.state;
  combo = next.result.lines ? combo + 1 : 0;
  const remaining = hand(state).find(item => !item.used);
  selected = remaining?.slot ?? 0;
  render();
  record("placement", `${slot + 1} at ${x + 1},${y + 1}; +${next.result.gained}; ${next.result.lines} lines`);
  status.textContent = next.result.lines ? "Clear · keep playing" : "Placed";
  blockHaptics.play(next.result.lines, next.result.gems);
  blockSound(next.result.lines, next.result.gems, combo);
  const base = pieceCells(next.piece).length;
  if (next.result.lines && splitCredit(variant)) {
    receipts.award(base, 0, 1);
    receipts.award(next.result.gained - base, reduced() ? 0 : 780, 2);
  } else receipts.award(next.result.gained, next.result.lines && !reduced() ? 780 : 0, 1);
  if (next.result.lines) clearEffects(next, x, y, splitCredit(variant) ? next.result.gained - base : next.result.gained);
  else if (!reduced()) {
    cells.forEach((cell, i) => { if ((next.placed >> BigInt(i)) & 1n) cell.classList.add("drop"); });
    later(() => cells.forEach(cell => cell.classList.remove("drop")), 280);
  }
  return true;
}

function clearEffects(next: Extract<PlacementOutcome, { accepted: true }>, x: number, y: number, points: number) {
  if (reduced()) return;
  const grid = measureGrid(space, board);
  const row = next.cleared.reduce((n, c) => n + Math.floor(c.i / 8) + .5, 0) / next.cleared.length;
  const layer = document.createElement("div");
  layer.className = "bp-clear-grid lab-effect";
  for (const c of next.cleared) {
    const node = document.createElement("span");
    node.className = `bp-cell pop k${c.color}${c.gem ? " gem" : ""}`;
    node.style.gridColumn = String(c.i % 8 + 1);
    node.style.gridRow = String(Math.floor(c.i / 8) + 1);
    node.style.animationDelay = `${Math.round(Math.hypot(c.i % 8 - (x + .5), Math.floor(c.i / 8) - (y + .5)) * 7)}ms`;
    layer.appendChild(node);
  }
  effects.appendChild(layer);
  for (let i = 0; i < 8; i++) for (const axis of ["row", "col"] as const) {
    const mask = axis === "row" ? 0xffn << BigInt(i * 8) : 0x0101010101010101n << BigInt(i);
    if ((next.result.cleared & mask) !== mask) continue;
    const sweep = document.createElement("span");
    sweep.className = "bp-sweep lab-effect";
    sweep.dataset.axis = axis;
    sweep.style.setProperty("--at", String(i));
    effects.appendChild(sweep);
    later(() => sweep.remove(), 450);
  }
  later(() => layer.remove(), 450);
  const text = clearCallout(next.result.lines, next.result.gems, combo);
  if (text) {
    const label = document.createElement("p");
    label.className = "lab-moment lab-effect";
    label.textContent = text;
    label.style.top = `${row / 8 * 100}%`;
    label.style.transform = row > 4 ? "translate(-50%,calc(-100% - 40px))" : "translate(-50%,40px)";
    effects.appendChild(label);
    label.animate([{ opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 1, offset: .7 }, { opacity: 0 }], { duration: 1000 });
    later(() => label.remove(), 1000);
  }
  const sx = grid.left + next.cleared.reduce((n,c) => n + c.i % 8 + .5, 0) / next.cleared.length * grid.pitch;
  const sy = grid.top + next.cleared.reduce((n,c) => n + Math.floor(c.i / 8) + .5, 0) / next.cleared.length * grid.pitch;
  const target = score.getBoundingClientRect();
  const fly = document.createElement("span");
  fly.className = "lab-points lab-effect";
  fly.textContent = `+${points}`;
  document.body.appendChild(fly);
  const at = (px: number, py: number, s: number) => `translate(${px}px,${py}px) translate(-50%,-50%) scale(${s})`;
  const a = fly.animate([
    { transform: at(sx, sy, .7), opacity: 0 },
    { transform: at(sx, sy - 8, 1.15), opacity: 1, offset: .12 },
    { transform: at(sx, sy - 12, 1), opacity: 1, offset: .46 },
    { transform: at(target.left + target.width / 2, target.top + target.height / 2, .45), opacity: 1, offset: .94 },
    { transform: at(target.left + target.width / 2, target.top + target.height / 2, .3), opacity: 0 },
  ], { duration: 780, easing: "cubic-bezier(.2,.7,.3,1)" });
  a.onfinish = a.oncancel = () => fly.remove();
  const kick = Math.min(7, 2.5 + next.result.lines + (next.result.gems ? 1 : 0));
  visual.animate([{ transform: "translate(0,0)" }, { transform: `translate(${-kick}px,2px)`, offset: .12 }, { transform: `translate(${kick * .6}px,-1px)`, offset: .4 }, { transform: `translate(${-kick * .25}px,0)`, offset: .7 }, { transform: "translate(0,0)" }], { duration: 190, easing: "ease-out" });
}

function expire() {
  if (expired) return;
  expired = true;
  cancel("90 seconds reached");
  receipts.settle(state.st.score);
  status.textContent = "90 seconds · Reset to repeat";
  render();
}
setInterval(() => {
  const remaining = deadline === null ? 90 : Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  app.querySelector("#timer")!.textContent = String(remaining);
  if (remaining === 0) expire();
}, 100);

function controls() {
  app.querySelector<HTMLSelectElement>("#variant")!.value = variant;
  app.querySelector<HTMLSelectElement>("#fixture")!.value = fixture;
  app.querySelector("#comparison")!.textContent = `${measuredMotion(variant) ? "Touch travel 1.5×; immediate full-size pickup centered above the tray at the board’s bottom (source plus device evidence)." : "Touch travel 1×; initial lift 64px (current code)."} ${splitCredit(variant) ? "Placement points arrive immediately; clear bonus arrives separately." : "All clear-move points arrive together after 780ms (current code)."} Clear effects retain current timings in every variant.`;
  app.querySelector("#vibration")!.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="4" width="10" height="16" rx="2"/><path d="M3 8v8M21 8v8"/>${blockHaptics.enabled() ? "" : '<path d="M2 2l20 20"/>'}</svg>`;
  app.querySelector("#vibration")!.setAttribute("aria-label", `Turn vibration ${blockHaptics.enabled() ? "off" : "on"}`);
  app.querySelector("#sound")!.textContent = isMuted() ? "♪̸" : "♪";
  app.querySelector("#sound")!.setAttribute("aria-label", `Turn sound ${isMuted() ? "on" : "off"}`);
}
function reset() {
  cancel();
  timers.forEach(clearTimeout); timers.clear();
  document.querySelectorAll(".lab-effect").forEach(node => node.remove());
  visual.getAnimations().forEach(a => a.cancel());
  state = initialFixture(fixture); selected = 0; combo = 0; deadline = null; expired = false;
  epoch = performance.now(); events.length = 0;
  receipts.reset();
  status.textContent = "Drag a piece onto the board";
  app.querySelector("#timer")!.textContent = "90";
  render(); controls();
  const url = new URL(location.href); url.searchParams.set("variant", variant); url.searchParams.set("fixture", fixture); history.replaceState(null, "", url);
  record("reset", `${fixture}; ${variant}`);
}
app.querySelector("#reset")!.addEventListener("click", reset);
app.querySelector("#variant")!.addEventListener("change", e => { variant = (e.target as HTMLSelectElement).value as Variant; reset(); });
app.querySelector("#fixture")!.addEventListener("change", e => { fixture = (e.target as HTMLSelectElement).value as FixtureId; reset(); });
app.querySelector("#vibration")!.addEventListener("click", () => { blockHaptics.setEnabled(!blockHaptics.enabled()); controls(); });
app.querySelector("#sound")!.addEventListener("click", () => { setMuted(!isMuted()); controls(); });
app.querySelector("#fullscreen")!.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  app.querySelector("#fullscreen")!.setAttribute("aria-label", document.fullscreenElement ? "Exit full screen" : "Enter full screen");
});
window.addEventListener("resize", () => cancel("viewport changed"));
window.addEventListener("blur", () => cancel("focus lost"));
window.addEventListener("scroll", () => cancel("page scrolled"), true);
armSound();
reset();
